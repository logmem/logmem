// cloud/meter — per-tenant monthly operation counters and quota checks.
//
// Spec: docs/cloud/BACKPLANE.md §2 and docs/PRICING.md "Caps".
//
//   acmi:cloud:meter:{tenant}:{yyyymm}:{op}         INCRBY per op (add | read | recall)
//   acmi:cloud:meter:{tenant}:{yyyymm}:ops_total    INCRBY for every op
//   TTL 400 days on each counter (refreshed on every increment).
//
// Quota rule:
//   - read is counted, never refused.
//   - limit null = unlimited.
//   - up to 100% of the limit: ok.
//   - plans without overage (free, dev): a 10% grace margin, then refuse with
//     quota_exceeded. Nothing is dropped silently; the caller surfaces the error.
//   - plans with billed overage (pro, team, agency, enterprise): never refused;
//     past the limit checkQuota returns {ok:true, overage:true} for billing.

import { validTenantId } from "../tenants/index.mjs";

export const OPS = ["add", "read", "recall"];
export const METER_TTL_SECONDS = 400 * 86400;

const MONTH_RE = /^\d{4}(0[1-9]|1[0-2])$/;

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/** "YYYYMM" in UTC. */
export function monthKey(ms = Date.now()) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) throw fail("invalid_time");
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const counterKey = (tenant, month, op) => `acmi:cloud:meter:${tenant}:${month}:${op}`;

function checkTenant(tenant) {
  if (!validTenantId(tenant)) throw fail("invalid_tenant");
}

function checkOp(op) {
  if (!OPS.includes(op)) throw fail("invalid_op");
}

function checkN(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw fail("invalid_count");
}

/** Count n ops. Returns the new monthly count for `op`. */
export async function meter(redis, tenant, op, n = 1, { now } = {}) {
  checkTenant(tenant);
  checkOp(op);
  checkN(n);
  const month = monthKey(now ?? Date.now());
  const k = counterKey(tenant, month, op);
  const total = counterKey(tenant, month, "ops_total");
  const count = Number(await redis("INCRBY", k, n));
  await redis("EXPIRE", k, METER_TTL_SECONDS);
  await redis("INCRBY", total, n);
  await redis("EXPIRE", total, METER_TTL_SECONDS);
  return count;
}

/** Usage summary for one tenant-month (default: the current UTC month). */
export async function usage(redis, tenant, { month } = {}) {
  checkTenant(tenant);
  const m = month ?? monthKey();
  if (typeof m !== "string" || !MONTH_RE.test(m)) throw fail("invalid_month");
  const out = { month: m };
  for (const op of [...OPS, "ops_total"]) {
    const v = Number(await redis("GET", counterKey(tenant, m, op)));
    out[op] = Number.isSafeInteger(v) && v > 0 ? v : 0;
  }
  return out;
}

/**
 * Would `n` more `op`s fit the plan this month? Does not count them; call
 * meter() after the op succeeds.
 *   {ok:true, used, limit, grace:false}
 *   {ok:true, used, limit, grace:true}                 (no-overage plan, inside the 10% margin)
 *   {ok:true, used, limit, grace:false, overage:true}  (billed-overage plan, past the limit)
 *   {ok:false, code:"quota_exceeded", used, limit}
 */
export async function checkQuota(redis, tenant, op, plan, { now, n = 1 } = {}) {
  checkTenant(tenant);
  checkOp(op);
  checkN(n);
  if (!plan || typeof plan !== "object" || !plan.limits || typeof plan.limits !== "object") throw fail("invalid_plan");
  const month = monthKey(now ?? Date.now());
  const raw = Number(await redis("GET", counterKey(tenant, month, op)));
  const used = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  const lim = plan.limits[op];
  const limit = lim === null || lim === undefined ? null : Number(lim);
  if (limit !== null && !(Number.isSafeInteger(limit) && limit >= 0)) throw fail("invalid_plan");

  if (op === "read" || limit === null) return { ok: true, used, limit, grace: false };
  const after = used + n;
  if (after <= limit) return { ok: true, used, limit, grace: false };
  if (plan.overage && plan.overage.billed === true) return { ok: true, used, limit, grace: false, overage: true };
  const ratio = Number.isFinite(plan.grace_ratio) && plan.grace_ratio >= 0 ? plan.grace_ratio : 0.1;
  // Integer margin; the epsilon absorbs float error (e.g. 0.1 * 30 = 3.0000000000000004).
  const graceMax = limit + Math.floor(limit * ratio + 1e-9);
  if (after <= graceMax) return { ok: true, used, limit, grace: true };
  return { ok: false, code: "quota_exceeded", used, limit };
}
