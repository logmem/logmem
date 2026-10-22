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
//           the same grace (Free: 100 a month plus 10%). Past it, recall is
//           refused with quota_exceeded; notes, views and the Brief still work.
//
// limits use the customer Redis directly (server code), never a jailed runner:
// the meter lives under acmi:cloud:meter:*.

import { checkQuota, meter, monthKey, METER_TTL_SECONDS } from "../../cloud/meter/index.mjs";
import { planFor, namespaceFor } from "../../cloud/tenants/index.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";

const DAY_MS = 24 * 3600 * 1000;

const AGENT_SLOT_LUA = `
if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then return 1 end
if redis.call("SCARD", KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call("SADD", KEYS[1], ARGV[1])
return 1
`;
registerEvalScript(AGENT_SLOT_LUA, (call, [key], [agent, cap]) => {
  if (Number(call("SISMEMBER", key, agent)) === 1) return 1;
  if (Number(call("SCARD", key)) >= Number(cap)) return 0;
  call("SADD", key, agent);
  return 1;
});

// Refusing plans admit the slot and add together. Neither refusal changes state.
const ADMIT_ADD_LUA = `
local used = tonumber(redis.call("GET", KEYS[2]) or "0") or 0
if used < 0 then used = 0 end
if used + 1 > tonumber(ARGV[3]) then return 0 end
if ARGV[1] ~= "" and tonumber(ARGV[2]) >= 0 then
  if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 0 then
    if redis.call("SCARD", KEYS[1]) >= tonumber(ARGV[2]) then return 2 end
    redis.call("SADD", KEYS[1], ARGV[1])
  end
end
redis.call("INCRBY", KEYS[2], 1)
redis.call("EXPIRE", KEYS[2], ARGV[4])
redis.call("INCRBY", KEYS[3], 1)
redis.call("EXPIRE", KEYS[3], ARGV[4])
return 1
`;
registerEvalScript(ADMIT_ADD_LUA, (call, [agents, counter, total], [agent, cap, max, ttl]) => {
  let used = Number(call("GET", counter));
  if (!Number.isFinite(used) || used < 0) used = 0;
  if (used + 1 > Number(max)) return 0;
  if (agent && Number(cap) >= 0 && Number(call("SISMEMBER", agents, agent)) === 0) {
    if (Number(call("SCARD", agents)) >= Number(cap)) return 2;
    call("SADD", agents, agent);
  }
  call("INCRBY", counter, 1);
  call("EXPIRE", counter, ttl);
  call("INCRBY", total, 1);
  call("EXPIRE", total, ttl);
  return 1;
});

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
      if (Number(await redis("EVAL", AGENT_SLOT_LUA, 1, agentsKey, agent, String(p.agents))) !== 1) {
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
      const agent = by.startsWith("agent:") ? by.slice("agent:".length) : "";
      if (p.limits?.add !== null && p.overage?.billed !== true) {
        const limit = p.limits?.add;
        const ratio = p.grace_ratio === undefined ? 0.1 : p.grace_ratio;
        if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
          // Reuse the meter's fail-closed validation before any mutation.
          await checkQuota(redis, tenant, "add", p, { now: now() });
        }
        const max = limit + Math.floor(limit * ratio + 1e-9);
        const prefix = `acmi:cloud:meter:${tenant}:${monthKey(now())}`;
        const admitted = Number(await redis("EVAL", ADMIT_ADD_LUA, 3, agentsKey, `${prefix}:add`, `${prefix}:ops_total`,
          agent, String(Number.isFinite(p.agents) ? p.agents : -1), String(max), String(METER_TTL_SECONDS)));
        if (admitted === 2) throw new LimitError("agent_limit", `${p.name} allows ${p.agents} agents. Disconnect one at logmem.si/app, or upgrade.`);
        if (admitted !== 1) throw new LimitError("quota_exceeded", `This space used its ${limit} ${p.name} entries this month. Reads still work. Upgrade at logmem.si.`);
        return async () => {};
      }
      const q = await checkQuota(redis, tenant, "add", p, { now: now() });
      if (!q.ok) {
        throw new LimitError("quota_exceeded", `This space used its ${q.limit} ${p.name} entries this month. Reads still work. Upgrade at logmem.si.`);
      }
      if (agent) await this.agentSlot(agent);
      return async () => {
        if (!q.reserved) await meter(redis, tenant, "add", 1, { now: now(), plan: p });
      };
    },
  };
}

// applyLimits lives in src/core so the stdio server (the npm package) never imports cloud/.
export { applyLimits } from "../core/apply-limits.mjs";
