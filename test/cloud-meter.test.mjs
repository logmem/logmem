import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { OPS, monthKey, meter, usage, checkQuota, METER_TTL_SECONDS } from "../cloud/meter/index.mjs";
import { planFor } from "../cloud/tenants/index.mjs";

const OCT = Date.UTC(2026, 9, 13, 12); // 2026-10-13
const LAST_MS_OCT = Date.UTC(2026, 10, 1) - 1; // 2026-10-31T23:59:59.999Z
const FIRST_MS_NOV = Date.UTC(2026, 10, 1);

// Record every command the meter sends, so tests can assert key shape and TTLs.
function recording() {
  const inner = createMemoryRedis();
  const calls = [];
  const redis = async (cmd, ...args) => {
    calls.push([cmd, ...args]);
    return inner(cmd, ...args);
  };
  return { redis, calls };
}

test("OPS and monthKey: UTC YYYYMM, zero-padded", () => {
  assert.deepEqual(OPS, ["add", "read", "recall"]);
  assert.equal(monthKey(OCT), "202610");
  assert.equal(monthKey(Date.UTC(2027, 0, 1)), "202701");
  assert.equal(monthKey(LAST_MS_OCT), "202610");
  assert.equal(monthKey(FIRST_MS_NOV), "202611");
  assert.match(monthKey(), /^\d{6}$/);
  assert.throws(() => monthKey(Number.NaN));
});

test("meter: INCRBY op and ops_total, EXPIRE 400d, returns op count", async () => {
  const { redis, calls } = recording();
  assert.equal(await meter(redis, "acme", "add", 1, { now: OCT }), 1);
  assert.equal(await meter(redis, "acme", "add", 4, { now: OCT }), 5);
  assert.equal(await meter(redis, "acme", "read", undefined, { now: OCT }), 1);
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "5");
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:ops_total"), "6");
  const incr = calls.filter((c) => c[0] === "INCRBY").map((c) => c[1]);
  assert.ok(incr.includes("acmi:cloud:meter:acme:202610:add"));
  assert.ok(incr.includes("acmi:cloud:meter:acme:202610:ops_total"));
  const expires = calls.filter((c) => c[0] === "EXPIRE");
  assert.equal(expires.length, 6, "both counters get a TTL on every increment");
  assert.ok(expires.every((c) => c[2] === 400 * 86400 && c[2] === METER_TTL_SECONDS));
});

test("meter: validates tenant, op and n", async () => {
  const redis = createMemoryRedis();
  await assert.rejects(meter(redis, "madez", "add"), { code: "invalid_tenant" });
  await assert.rejects(meter(redis, "a:b:c", "add"), { code: "invalid_tenant" });
  await assert.rejects(meter(redis, "acme", "ops_total"), { code: "invalid_op" });
  await assert.rejects(meter(redis, "acme", "write"), { code: "invalid_op" });
  for (const n of [0, -1, 1.5, "2", Number.NaN]) {
    await assert.rejects(meter(redis, "acme", "add", n), { code: "invalid_count" });
  }
  assert.equal((await redis("KEYS", "*")).length, 0, "nothing written on bad input");
});

test("meter + usage: month rollover starts fresh counters", async () => {
  const redis = createMemoryRedis();
  await meter(redis, "acme", "add", 3, { now: LAST_MS_OCT });
  await meter(redis, "acme", "recall", 2, { now: LAST_MS_OCT });
  await meter(redis, "acme", "add", 1, { now: FIRST_MS_NOV });
  assert.deepEqual(await usage(redis, "acme", { month: "202610" }), { month: "202610", add: 3, read: 0, recall: 2, ops_total: 5 });
  assert.deepEqual(await usage(redis, "acme", { month: "202611" }), { month: "202611", add: 1, read: 0, recall: 0, ops_total: 1 });
  assert.deepEqual(await usage(redis, "acme", { month: "202612" }), { month: "202612", add: 0, read: 0, recall: 0, ops_total: 0 });

  const plan = { limits: { add: 3, read: null, recall: null }, overage: null };
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: LAST_MS_OCT })).ok, false, "October is full");
  const nov = await checkQuota(redis, "acme", "add", plan, { now: FIRST_MS_NOV });
  assert.deepEqual(nov, { ok: true, used: 1, limit: 3, grace: false }, "November has its own budget");
});

test("usage: default month is current; bad month refused; tenants isolated", async () => {
  const redis = createMemoryRedis();
  await meter(redis, "acme", "add", 2);
  await meter(redis, "beta", "add", 7);
  const u = await usage(redis, "acme");
  assert.equal(u.month, monthKey());
  assert.equal(u.add, 2);
  assert.equal((await usage(redis, "beta")).add, 7);
  for (const month of ["2026-10", "202613", "202600", "20261", "*", 202610]) {
    await assert.rejects(usage(redis, "acme", { month }), { code: "invalid_month" });
  }
  await assert.rejects(usage(redis, "probe"), { code: "invalid_tenant" });
});

test("checkQuota: free plan grace boundary (10k adds, 11k with grace, then refuse)", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("free");
  assert.equal(plan.limits.add, 10000);
  const at = async (n) => {
    await redis("SET", "acmi:cloud:meter:acme:202610:add", String(n));
    return checkQuota(redis, "acme", "add", plan, { now: OCT });
  };
  assert.deepEqual(await at(0), { ok: true, used: 0, limit: 10000, grace: false });
  assert.deepEqual(await at(9999), { ok: true, used: 9999, limit: 10000, grace: false }, "the 10000th add is within limit");
  assert.deepEqual(await at(10000), { ok: true, used: 10000, limit: 10000, grace: true }, "10001st add is grace");
  assert.deepEqual(await at(10999), { ok: true, used: 10999, limit: 10000, grace: true }, "11000th add is the last grace add");
  assert.deepEqual(await at(11000), { ok: false, code: "quota_exceeded", used: 11000, limit: 10000 });
  assert.deepEqual(await at(50000), { ok: false, code: "quota_exceeded", used: 50000, limit: 10000 });

  // n > 1: a batch that would cross the grace edge is refused whole.
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "10990");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT, n: 10 })).ok, true);
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT, n: 11 })).ok, false);
});

test("checkQuota: grace margin is exact integer math for awkward limits", async () => {
  const redis = createMemoryRedis();
  const plan = { limits: { add: 30, read: null, recall: null }, overage: null };
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "32");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT })).grace, true, "33 <= 30 + 3");
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "33");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT })).ok, false);
});

test("checkQuota: add refused past grace, read never refused", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("dev");
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "1000000");
  await redis("SET", "acmi:cloud:meter:acme:202610:read", "99999999");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT })).code, "quota_exceeded");
  const r = await checkQuota(redis, "acme", "read", plan, { now: OCT, n: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.grace, false);
  assert.equal(r.used, 99999999, "reads are still counted");

  // Even a plan that (wrongly) sets a read limit does not refuse reads.
  const odd = { limits: { add: 1, read: 1, recall: 1 }, overage: null };
  assert.equal((await checkQuota(redis, "acme", "read", odd, { now: OCT })).ok, true);
});

test("checkQuota: recall follows the same grace rule on no-overage plans", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("free");
  const lim = plan.limits.recall;
  await redis("SET", "acmi:cloud:meter:acme:202610:recall", String(lim + Math.floor(lim / 10)));
  assert.equal((await checkQuota(redis, "acme", "recall", plan, { now: OCT })).code, "quota_exceeded");
});

test("checkQuota: paid plans bill overage instead of refusing", async () => {
  const redis = createMemoryRedis();
  for (const name of ["pro", "team", "agency"]) {
    const plan = planFor(name);
    const lim = plan.limits.add;
    await redis("SET", "acmi:cloud:meter:acme:202610:add", String(lim - 1));
    assert.deepEqual(await checkQuota(redis, "acme", "add", plan, { now: OCT }), { ok: true, used: lim - 1, limit: lim, grace: false });
    await redis("SET", "acmi:cloud:meter:acme:202610:add", String(lim * 5));
    assert.deepEqual(
      await checkQuota(redis, "acme", "add", plan, { now: OCT }),
      { ok: true, used: lim * 5, limit: lim, grace: false, overage: true },
      `${name} never refuses`,
    );
  }
});

test("checkQuota: limit null = unlimited (enterprise)", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("enterprise");
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "999999999");
  assert.deepEqual(await checkQuota(redis, "acme", "add", plan, { now: OCT }), { ok: true, used: 999999999, limit: null, grace: false });
});

test("checkQuota: does not count; validates inputs", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("free");
  await checkQuota(redis, "acme", "add", plan, { now: OCT });
  assert.equal((await redis("KEYS", "*")).length, 0);
  await assert.rejects(checkQuota(redis, "admin", "add", plan), { code: "invalid_tenant" });
  await assert.rejects(checkQuota(redis, "acme", "delete", plan), { code: "invalid_op" });
  await assert.rejects(checkQuota(redis, "acme", "add", null), { code: "invalid_plan" });
  await assert.rejects(checkQuota(redis, "acme", "add", { limits: { add: -1 } }), { code: "invalid_plan" });
  await assert.rejects(checkQuota(redis, "acme", "add", plan, { n: 0 }), { code: "invalid_count" });
});

test("meter -> checkQuota end to end on the free plan", async () => {
  const redis = createMemoryRedis();
  const plan = { ...planFor("free"), limits: { add: 10, read: null, recall: 10 } };
  let accepted = 0;
  for (let i = 0; i < 20; i++) {
    const q = await checkQuota(redis, "acme", "add", plan, { now: OCT });
    if (!q.ok) break;
    await meter(redis, "acme", "add", 1, { now: OCT });
    accepted++;
  }
  assert.equal(accepted, 11, "10 + 10% grace");
  assert.equal((await usage(redis, "acme", { month: "202610" })).add, 11);
});

test("L3: checkQuota fails closed on a missing op limit and a bad grace_ratio", async () => {
  const redis = createMemoryRedis();
  for (const op of OPS) {
    await assert.rejects(checkQuota(redis, "acme", op, { limits: {} }, { now: OCT }), { code: "invalid_plan" }, op);
  }
  await assert.rejects(checkQuota(redis, "acme", "add", { limits: { add: undefined } }), { code: "invalid_plan" });
  await assert.rejects(checkQuota(redis, "acme", "add", { limits: { add: "10" } }), { code: "invalid_plan" });
  for (const grace_ratio of [-0.1, 1.01, 10, 1e9, Number.NaN, "0.1", null]) {
    await assert.rejects(checkQuota(redis, "acme", "add", { limits: { add: 0 }, grace_ratio }), { code: "invalid_plan" }, String(grace_ratio));
  }
  // Explicit null is the only "unlimited"; 0 and 1 are valid grace ratios.
  assert.equal((await checkQuota(redis, "acme", "add", { limits: { add: null } })).ok, true);
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "10");
  assert.equal((await checkQuota(redis, "acme", "add", { limits: { add: 10 }, grace_ratio: 0 }, { now: OCT })).ok, false);
  assert.equal((await checkQuota(redis, "acme", "add", { limits: { add: 10 }, grace_ratio: 1 }, { now: OCT })).grace, true);
});
