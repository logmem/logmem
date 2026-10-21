// usage-meter.mjs — count every op where no plan limits apply (the fleet, self-hosted).
//
// Managed accounts are metered by their limits (src/http/limits.mjs, cloud/meter).
// Without limits nothing counted, so recall use could not be measured. This
// meter only counts. It never refuses an op, and a counting failure never
// fails a tool call.
//
//   lm:{space}:usage:{yyyymm}:{op}       INCR per op (add | read | recall | ops_total)
//   lm:{space}:usage:{yyyymm}:agents     SADD for each agent that writes in the month
//   TTL 400 days, refreshed on every count.
//
// Units: one add per written entry, one recall per recall call, one read per
// read-only tool call. No imports from cloud/, so the stdio package ships it.
// Turn it off with LOGMEM_METER=off.

export const USAGE_OPS = ["add", "read", "recall"];
export const USAGE_TTL_SECONDS = 400 * 86400;

/** "YYYYMM" in UTC. Same month key as cloud/meter. */
export function usageMonth(ms = Date.now()) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) throw new Error("invalid_time");
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const usageKey = (space, month, field) => `lm:${space}:usage:${month}:${field}`;

/** False when LOGMEM_METER is off, 0, false or no. */
export function meterOnFromEnv(env = process.env) {
  return !["off", "0", "false", "no"].includes(String(env.LOGMEM_METER ?? "").trim().toLowerCase());
}

/**
 * A count-only meter for one space. `redis` is a runner: (cmd, ...args) => result.
 * `onError` sees a failed count (default: ignore). Counts never throw.
 */
export function createUsageMeter(redis, space, { now = Date.now, onError = () => {} } = {}) {
  const bump = async (key) => {
    await redis("INCR", key);
    await redis("EXPIRE", key, USAGE_TTL_SECONDS);
  };
  const safe = async (fn) => {
    try {
      await fn();
    } catch (e) {
      try { onError(e); } catch { /* never let reporting fail a call */ }
    }
  };

  return {
    /** Count one op. */
    count(op) {
      if (!USAGE_OPS.includes(op)) return Promise.resolve();
      return safe(async () => {
        const m = usageMonth(now());
        await bump(usageKey(space, m, op));
        await bump(usageKey(space, m, "ops_total"));
      });
    },

    /** Record an agent as active this month. `by` is "agent:<id>"; others are ignored. */
    agent(by) {
      const s = String(by || "");
      if (!s.startsWith("agent:") || s.length <= "agent:".length) return Promise.resolve();
      return safe(async () => {
        const k = usageKey(space, usageMonth(now()), "agents");
        await redis("SADD", k, s.slice("agent:".length));
        await redis("EXPIRE", k, USAGE_TTL_SECONDS);
      });
    },
  };
}

/** Read one space-month: { month, add, read, recall, ops_total, agents }. */
export async function readUsage(redis, space, { month = usageMonth() } = {}) {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(String(month))) throw new Error("invalid_month");
  const out = { space, month };
  for (const f of [...USAGE_OPS, "ops_total"]) {
    const v = Number(await redis("GET", usageKey(space, month, f)));
    out[f] = Number.isSafeInteger(v) && v > 0 ? v : 0;
  }
  out.agents = Number(await redis("SCARD", usageKey(space, month, "agents"))) || 0;
  return out;
}

/** Wrap a store so each written entry counts as one add and marks its agent active. */
export function applyUsageMeter(store, meter) {
  if (!meter) return store;
  const append = store.append.bind(store);
  store.append = async (ns, id, entry) => {
    const out = await append(ns, id, entry);
    await meter.count("add");
    await meter.agent(entry?.by);
    return out;
  };
  return store;
}
