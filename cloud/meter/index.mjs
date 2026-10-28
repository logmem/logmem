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
//   - limit null = unlimited; a missing limit (undefined) is invalid_plan (fail closed).
//   - grace_ratio, if given, must be in [0, 1]; default 0.1.
//   - up to 100% of the limit: ok.
//   - plans without overage (free, dev, pro, team, scale): a 10% grace margin,
//     then refuse with quota_exceeded. No plan bills overage (Mikey, Oct 27). The check and the increment are one EVAL, so concurrent
//     callers cannot both pass the grace cap. A refusal does not increment.
//     Nothing is dropped silently; the caller surfaces the error.
//   - plans with billed overage (enterprise only, by contract): never refused;
//     past the limit checkQuota returns {ok:true, overage:true} for billing
//     and does not reserve. meter() counts those after the op.
//   - recall caps and the quota_exceeded code are unchanged (pending a pricing
//     decision). Do not rename the refusal to upgrade_required here.

import { validTenantId } from "../tenants/index.mjs";
import { registerEvalScript } from "../../src/lib/lua-scripts.mjs";

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

/** Count n ops. Returns the new monthly count for `op`.
 *  Pass `plan` for a refusing plan (no billed overage): the increment is then
 *  the same atomic reserve as checkQuota, and a cap breach throws quota_exceeded
 *  without changing the counter. Omit `plan` to count unconditionally. */
export async function meter(redis, tenant, op, n = 1, { now, plan } = {}) {
  checkTenant(tenant);
  checkOp(op);
  checkN(n);
  const month = monthKey(now ?? Date.now());
  if (plan && refuses(plan, op)) {
    const r = await reserve(redis, tenant, op, n, month, plan);
    if (!r.ok) throw fail("quota_exceeded");
    return r.usedAfter;
  }
  return count(redis, tenant, month, op, n);
}

async function count(redis, tenant, month, op, n) {
  const k = counterKey(tenant, month, op);
  const total = counterKey(tenant, month, "ops_total");
  const value = Number(await redis("INCRBY", k, n));
  await redis("EXPIRE", k, METER_TTL_SECONDS);
  await redis("INCRBY", total, n);
  await redis("EXPIRE", total, METER_TTL_SECONDS);
  return value;
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

function limitOf(plan, op) {
  if (!plan || typeof plan !== "object" || !plan.limits || typeof plan.limits !== "object") throw fail("invalid_plan");
  // Fail closed: only an explicit null means unlimited; a missing limit is a broken plan.
  if (!Object.hasOwn(plan.limits, op)) throw fail("invalid_plan");
  const lim = plan.limits[op];
  if (lim !== null && !(Number.isSafeInteger(lim) && lim >= 0)) throw fail("invalid_plan");
  const gr = plan.grace_ratio;
  if (gr !== undefined && !(Number.isFinite(gr) && gr >= 0 && gr <= 1)) throw fail("invalid_plan");
  return lim;
}

/** True when this op is refused past the grace cap (free/dev add and recall). */
function refuses(plan, op) {
  const limit = limitOf(plan, op);
  if (op === "read" || limit === null) return false;
  return !(plan.overage && plan.overage.billed === true);
}

function graceMaxOf(plan, limit) {
  const ratio = plan.grace_ratio === undefined ? 0.1 : plan.grace_ratio; // validated in limitOf
  // Integer margin; the epsilon absorbs float error (e.g. 0.1 * 30 = 3.0000000000000004).
  return limit + Math.floor(limit * ratio + 1e-9);
}

// Atomic check-and-increment for a refusing plan. Returns
// {1, usedBefore, usedAfter, grace} or {0, usedBefore}. A real Redis runs
// this script; memory-redis runs applyReserve, which matches it.
export const RESERVE_LUA = `
local key = KEYS[1]
local total = KEYS[2]
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local graceMax = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
if not n or n < 1 or n ~= math.floor(n) then return redis.error_reply("ERR invalid count") end
local cur = tonumber(redis.call("GET", key) or "0") or 0
if cur < 0 then cur = 0 end
if cur + n > graceMax then return {0, cur} end
local used = tonumber(redis.call("INCRBY", key, n))
redis.call("EXPIRE", key, ttl)
redis.call("INCRBY", total, n)
redis.call("EXPIRE", total, ttl)
local grace = 0
if used > limit then grace = 1 end
return {1, cur, used, grace}
`;

function applyReserve(call, keys, argv) {
  const [key, total] = keys;
  const n = Number(argv[0]);
  const limit = Number(argv[1]);
  const graceMax = Number(argv[2]);
  const ttl = Number(argv[3]);
  // Same guard as the Lua: a reserve is for n >= 1 only (a negative n would
  // decrement usage, n = 0 is meaningless).
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("ERR invalid count");
  let cur = Number(call("GET", key));
  if (!Number.isFinite(cur) || cur < 0) cur = 0;
  if (cur + n > graceMax) return [0, cur];
  const used = Number(call("INCRBY", key, n));
  call("EXPIRE", key, ttl);
  call("INCRBY", total, n);
  call("EXPIRE", total, ttl);
  return [1, cur, used, used > limit ? 1 : 0];
}

registerEvalScript(RESERVE_LUA, applyReserve);

async function reserve(redis, tenant, op, n, month, plan) {
  const limit = limitOf(plan, op);
  const graceMax = graceMaxOf(plan, limit);
  const res = await redis(
    "EVAL", RESERVE_LUA, 2,
    counterKey(tenant, month, op), counterKey(tenant, month, "ops_total"),
    String(n), String(limit), String(graceMax), String(METER_TTL_SECONDS),
  );
  if (!Array.isArray(res) || Number(res[0]) !== 1) {
    const used = Number(res?.[1]);
    return { ok: false, code: "quota_exceeded", used: Number.isFinite(used) ? used : 0, limit };
  }
  return {
    ok: true,
    used: Number(res[1]),
    usedAfter: Number(res[2]),
    limit,
    grace: Number(res[3]) === 1,
  };
}

async function readUsed(redis, tenant, month, op) {
  const raw = Number(await redis("GET", counterKey(tenant, month, op)));
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * Would `n` more `op`s fit the plan this month?
 *
 * `reserved` says whether this call already counted the op:
 *   - reserved:true  — refusing plan (free, dev, pro, team, scale: no billed overage), add/recall with a
 *     finite limit, and the answer is yes. The check and INCRBY ran as one atomic
 *     reservation. Do NOT also call meter() for this op.
 *   - reserved:false — everything else: reads, unlimited limits, billed-overage
 *     plans, and every refusal (a refusal never increments). Call meter() after
 *     the op succeeds (not after a refusal).
 * Results (`used` is the count before this call):
 *   {ok:true,  used, limit, grace:false, reserved}
 *   {ok:true,  used, limit, grace:true,  reserved:true}                 (inside the 10% margin)
 *   {ok:true,  used, limit, grace:false, overage:true, reserved:false}  (billed-overage plan, past the limit)
 *   {ok:false, code:"quota_exceeded", used, limit, reserved:false}
 */
export async function checkQuota(redis, tenant, op, plan, { now, n = 1 } = {}) {
  checkTenant(tenant);
  checkOp(op);
  checkN(n);
  const limit = limitOf(plan, op);
  const month = monthKey(now ?? Date.now());

  if (op === "read" || limit === null) {
    return { ok: true, used: await readUsed(redis, tenant, month, op), limit, grace: false, reserved: false };
  }
  if (plan.overage && plan.overage.billed === true) {
    const used = await readUsed(redis, tenant, month, op);
    if (used + n <= limit) return { ok: true, used, limit, grace: false, reserved: false };
    return { ok: true, used, limit, grace: false, overage: true, reserved: false };
  }
  const reserved = await reserve(redis, tenant, op, n, month, plan);
  if (!reserved.ok) return { ok: false, code: "quota_exceeded", used: reserved.used, limit, reserved: false };
  return { ok: true, used: reserved.used, limit, grace: reserved.grace, reserved: true };
}
