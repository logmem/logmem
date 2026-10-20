// limits.mjs — enforce a managed account's plan (Free first).
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md, 4.6.
// Numbers come from cloud/plans.json through planFor(); none are hard-coded.
//
//   adds    every written entry is one add. checkQuota reserves it atomically
//           (cloud/meter): Free and Dev get a 10% grace, then writes are refused
//           with quota_exceeded. Reads still work. Billed-overage plans are
//           counted after the write and never refused.
//   agents  the first write by an agent takes a slot in lm:t-{id}:agents. Past
//           the plan's count, that agent's writes are refused.
//   history reads see entries from the last history_days only. Nothing is
//           deleted, so an upgrade shows older entries again.
//   recall  every logmem_recall is one recall, reserved on the same meter with
//           the same grace (Free: 1,000 a month plus 10%). Past it, recall is
//           refused with quota_exceeded; notes, views and the Brief still work.
//
// limits use the customer Redis directly (server code), never a jailed runner:
// the meter lives under acmi:cloud:meter:*.

import { checkQuota, meter } from "../../cloud/meter/index.mjs";
import { planFor, namespaceFor } from "../../cloud/tenants/index.mjs";

const DAY_MS = 24 * 3600 * 1000;

export class LimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LimitError";
    this.code = code;
  }
}

/**
 * Limits for one tenant. `plan` is a plan name or a planFor() result.
 * deps: { redis: customer Redis runner (unjailed), now }.
 */
export function createLimits({ redis, tenant, plan, now = Date.now } = {}) {
  const p = typeof plan === "object" && plan?.id ? plan : planFor(plan);
  const agentsKey = `lm:${namespaceFor(tenant)}:agents`;

  return {
    plan: p,

    /** Lowest ts a read may return, or null when the plan keeps all history visible. */
    historyFloorMs() {
      return Number.isFinite(p.history_days) && p.history_days > 0 ? now() - p.history_days * DAY_MS : null;
    },

    /** Take an agent slot on its first write. Refuses past the plan's agent count. */
    async agentSlot(agent) {
      if (!Number.isFinite(p.agents)) return;
      if (Number(await redis("SISMEMBER", agentsKey, agent)) === 1) return;
      await redis("SADD", agentsKey, agent);
      if (Number(await redis("SCARD", agentsKey)) > p.agents) {
        await redis("SREM", agentsKey, agent);
        throw new LimitError("agent_limit", `${p.name} allows ${p.agents} agents. Disconnect one at logmem.si/app, or upgrade.`);
      }
    },

    /** Check before one recall. Returns a commit() to call after the recall returns. */
    async beforeRecall() {
      const q = await checkQuota(redis, tenant, "recall", p, { now: now() });
      if (!q.ok) {
        throw new LimitError("quota_exceeded", `This space used its ${q.limit} ${p.name} recalls this month. Notes, views and the Brief still work. Upgrade at logmem.si.`);
      }
      return async () => {
        if (!q.reserved) await meter(redis, tenant, "recall", 1, { now: now(), plan: p });
      };
    },

    /** Check before one entry is written. Returns a commit() to call after the write succeeds. */
    async beforeWrite(entry) {
      const by = String(entry?.by || "");
      if (by.startsWith("agent:")) await this.agentSlot(by.slice("agent:".length));
      const q = await checkQuota(redis, tenant, "add", p, { now: now() });
      if (!q.ok) {
        throw new LimitError("quota_exceeded", `This space used its ${q.limit} ${p.name} entries this month. Reads still work. Upgrade at logmem.si.`);
      }
      return async () => {
        if (!q.reserved) await meter(redis, tenant, "add", 1, { now: now(), plan: p });
      };
    },
  };
}

/** Apply limits to a store in place: every append is checked, every log read gets the history floor. */
export function applyLimits(store, limits) {
  if (!limits) return store;
  const append = store.append.bind(store);
  const readLog = store.readLog.bind(store);
  const getRecap = store.getRecap.bind(store);
  store.append = async (ns, id, entry) => {
    const commit = await limits.beforeWrite(entry);
    const out = await append(ns, id, entry);
    await commit();
    return out;
  };
  store.readLog = async (ns, id, opts = {}) => {
    const floor = limits.historyFloorMs();
    if (floor == null) return readLog(ns, id, opts);
    const sinceMs = opts.sinceMs != null ? Math.max(Number(opts.sinceMs), floor) : floor;
    return readLog(ns, id, { ...opts, sinceMs });
  };
  store.getRecap = async (agent) => {
    const r = await getRecap(agent);
    const floor = limits.historyFloorMs();
    if (!r || floor == null) return r;
    const at = Number(r.updated_at ?? r.ended_at ?? 0);
    return at >= floor ? r : null;
  };
  return store;
}
