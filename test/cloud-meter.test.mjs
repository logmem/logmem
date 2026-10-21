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
  assert.deepEqual(nov, { ok: true, used: 1, limit: 3, grace: false, reserved: true }, "November has its own budget");
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

test("checkQuota: free plan grace boundary (1k adds, 1.1k with grace, then refuse)", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("free");
  assert.equal(plan.limits.add, 1000);
  const at = async (n) => {
    await redis("SET", "acmi:cloud:meter:acme:202610:add", String(n));
    return checkQuota(redis, "acme", "add", plan, { now: OCT });
  };
  assert.deepEqual(await at(0), { ok: true, used: 0, limit: 1000, grace: false, reserved: true });
  assert.deepEqual(await at(999), { ok: true, used: 999, limit: 1000, grace: false, reserved: true }, "the 1000th add is within limit");
  assert.deepEqual(await at(1000), { ok: true, used: 1000, limit: 1000, grace: true, reserved: true }, "1001st add is grace");
  assert.deepEqual(await at(1099), { ok: true, used: 1099, limit: 1000, grace: true, reserved: true }, "1100th add is the last grace add");
  assert.deepEqual(await at(1100), { ok: false, code: "quota_exceeded", used: 1100, limit: 1000, reserved: false });
  assert.deepEqual(await at(5000), { ok: false, code: "quota_exceeded", used: 5000, limit: 1000, reserved: false });

  // n > 1: a batch that would cross the grace edge is refused whole, and not reserved.
  const addKey = "acmi:cloud:meter:acme:202610:add";
  await redis("SET", addKey, "1090");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT, n: 10 })).ok, true);
  assert.equal(await redis("GET", addKey), "1100", "a batch that fits is reserved");
  await redis("SET", addKey, "1090");
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT, n: 11 })).ok, false);
  assert.equal(await redis("GET", addKey), "1090", "a refused batch does not increment");
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
    assert.deepEqual(await checkQuota(redis, "acme", "add", plan, { now: OCT }), { ok: true, used: lim - 1, limit: lim, grace: false, reserved: false });
    await redis("SET", "acmi:cloud:meter:acme:202610:add", String(lim * 5));
    assert.deepEqual(
      await checkQuota(redis, "acme", "add", plan, { now: OCT }),
      { ok: true, used: lim * 5, limit: lim, grace: false, overage: true, reserved: false },
      `${name} never refuses`,
    );
  }
});

test("checkQuota: limit null = unlimited (enterprise)", async () => {
  const redis = createMemoryRedis();
  const plan = planFor("enterprise");
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "999999999");
  assert.deepEqual(await checkQuota(redis, "acme", "add", plan, { now: OCT }), { ok: true, used: 999999999, limit: null, grace: false, reserved: false });
});

test("checkQuota: refusing plans reserve; paid plans, reads, and bad input do not", async () => {
  const redis = createMemoryRedis();
  const free = planFor("free");
  await assert.rejects(checkQuota(redis, "admin", "add", free), { code: "invalid_tenant" });
  await assert.rejects(checkQuota(redis, "acme", "delete", free), { code: "invalid_op" });
  await assert.rejects(checkQuota(redis, "acme", "add", null), { code: "invalid_plan" });
  await assert.rejects(checkQuota(redis, "acme", "add", { limits: { add: -1 } }), { code: "invalid_plan" });
  await assert.rejects(checkQuota(redis, "acme", "add", free, { n: 0 }), { code: "invalid_count" });
  assert.equal((await redis("KEYS", "*")).length, 0, "bad input writes nothing");

  const paid = planFor("pro");
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "10");
  await checkQuota(redis, "acme", "add", paid, { now: OCT });
  await checkQuota(redis, "acme", "read", free, { now: OCT, n: 5 });
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "10", "a billed plan is not reserved");
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:read"), null, "reads are not reserved");

  const ok = await checkQuota(redis, "acme", "add", free, { now: OCT });
  assert.equal(ok.ok, true);
  assert.equal(ok.used, 10, "used is the count before this reserve");
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "11");
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:ops_total"), "1");
});

test("checkQuota: a refusing plan reserves atomically and stops at the grace cap", async () => {
  const redis = createMemoryRedis();
  const plan = { ...planFor("free"), limits: { add: 10, read: null, recall: 10 } };
  let accepted = 0;
  for (let i = 0; i < 20; i++) {
    const q = await checkQuota(redis, "acme", "add", plan, { now: OCT });
    if (!q.ok) {
      assert.equal(q.code, "quota_exceeded");
      break;
    }
    accepted++;
  }
  assert.equal(accepted, 11, "10 + 10% grace");
  assert.equal((await usage(redis, "acme", { month: "202610" })).add, 11);
  assert.equal((await checkQuota(redis, "acme", "add", plan, { now: OCT })).code, "quota_exceeded");
  assert.equal((await usage(redis, "acme", { month: "202610" })).add, 11, "a refusal does not increment");

  await redis("SET", "acmi:cloud:meter:acme:202610:add", "10");
  const pair = await Promise.all([
    checkQuota(redis, "acme", "add", plan, { now: OCT }),
    checkQuota(redis, "acme", "add", plan, { now: OCT }),
  ]);
  assert.equal(pair.filter((r) => r.ok).length, 1, "only one of two concurrent reserves fits");
  assert.equal(pair.filter((r) => r.code === "quota_exceeded").length, 1);
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "11");
});

test("meter: a refusing plan re-checks and will not pass the grace cap", async () => {
  const redis = createMemoryRedis();
  const plan = { ...planFor("free"), limits: { add: 10, read: null, recall: 10 } };
  let accepted = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await meter(redis, "acme", "add", 1, { now: OCT, plan });
      accepted++;
    } catch (e) {
      assert.equal(e.code, "quota_exceeded");
      break;
    }
  }
  assert.equal(accepted, 11);
  await assert.rejects(meter(redis, "acme", "add", 1, { now: OCT, plan }), { code: "quota_exceeded" });
  assert.equal((await usage(redis, "acme", { month: "202610" })).add, 11);

  await redis("SET", "acmi:cloud:meter:acme:202610:add", "10");
  const pair = await Promise.allSettled([
    meter(redis, "acme", "add", 1, { now: OCT, plan }),
    meter(redis, "acme", "add", 1, { now: OCT, plan }),
  ]);
  assert.equal(pair.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "11");
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

test("checkQuota.reserved: true exactly when the call already counted the op", async () => {
  const redis = createMemoryRedis();
  const get = async (op) => Number((await redis("GET", `acmi:cloud:meter:acme:202610:${op}`)) || 0);
  const cases = [
    // [plan, op, expect reserved, expect counter delta]
    [planFor("free"), "add", true, 3],
    [planFor("dev"), "recall", true, 3],
    [planFor("free"), "read", false, 0],
    [planFor("pro"), "add", false, 0],
    [planFor("agency"), "recall", false, 0],
    [planFor("enterprise"), "add", false, 0],
    [{ limits: { add: null, read: null, recall: null }, overage: null }, "add", false, 0],
  ];
  for (const [plan, op, reserved, delta] of cases) {
    const before = await get(op);
    const q = await checkQuota(redis, "acme", op, plan, { now: OCT, n: 3 });
    assert.equal(q.ok, true);
    assert.equal(q.reserved, reserved, `${plan.id ?? "custom"} ${op}`);
    assert.equal((await get(op)) - before, delta, `${plan.id ?? "custom"} ${op}: counted ${delta}`);
  }
  // Refusal: reserved:false and nothing counted.
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "11000");
  const r = await checkQuota(redis, "acme", "add", planFor("free"), { now: OCT });
  assert.deepEqual([r.ok, r.reserved], [false, false]);
  assert.equal(await get("add"), 11000);
  // Billed overage past the limit: not reserved; the caller meters after the op.
  await redis("SET", "acmi:cloud:meter:acme:202610:add", "999999999");
  const o = await checkQuota(redis, "acme", "add", planFor("pro"), { now: OCT });
  assert.deepEqual([o.ok, o.overage, o.reserved], [true, true, false]);
});

test("checkQuota: concurrent reservations on a refusing plan never pass the grace cap", async () => {
  const redis = createMemoryRedis();
  const plan = { limits: { add: 10, read: null, recall: null }, overage: null };
  const res = await Promise.all(Array.from({ length: 30 }, () => checkQuota(redis, "acme", "add", plan, { now: OCT })));
  assert.equal(res.filter((q) => q.ok && q.reserved).length, 11);
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:add"), "11");
  assert.equal(await redis("GET", "acmi:cloud:meter:acme:202610:ops_total"), "11");
});

test("redis-native: control-plane commands reach Redis verbatim (EVAL, INCRBY, HSETNX, SISMEMBER, ZADD LT)", async () => {
  const { translate } = await import("../src/lib/redis-native.mjs");
  const sent = [];
  const client = {
    sendCommand: async (argv) => {
      sent.push(argv);
      return argv[0] === "EVAL" ? [1, 0, 1, 0] : 1;
    },
    zAdd: async () => {
      throw new Error("flagged ZADD must not go through zAdd");
    },
  };
  assert.deepEqual(await translate(client, "EVAL", ["return 1", "2", "k1", "k2", "3"]), [1, 0, 1, 0]);
  await translate(client, "evalsha", ["abc", "0"]);
  await translate(client, "INCRBY", ["k", 5]);
  await translate(client, "DECRBY", ["k", "5"]);
  await translate(client, "HSETNX", ["h", "f", "v"]);
  await translate(client, "SISMEMBER", ["s", "m"]);
  await translate(client, "ZADD", ["z", "LT", 123, "at"]);
  assert.deepEqual(sent, [
    ["EVAL", "return 1", "2", "k1", "k2", "3"],
    ["EVALSHA", "abc", "0"],
    ["INCRBY", "k", "5"],
    ["DECRBY", "k", "5"],
    ["HSETNX", "h", "f", "v"],
    ["SISMEMBER", "s", "m"],
    ["ZADD", "z", "LT", "123", "at"],
  ]);
  // Plain ZADD keeps the existing typed path.
  let typed = null;
  await translate({ zAdd: async (k, m) => (typed = [k, m]) }, "ZADD", ["z", "1", "a"]);
  assert.deepEqual(typed, ["z", [{ score: 1, value: "a" }]]);
});

test("lua-scripts: cloud modules register with the neutral registry, not the test double", async () => {
  const { readFileSync } = await import("node:fs");
  const { evalScriptFor } = await import("../src/lib/lua-scripts.mjs");
  const { RESERVE_LUA } = await import("../cloud/meter/index.mjs");
  const { CREATE_TENANT_LUA } = await import("../cloud/tenants/index.mjs");
  assert.equal(typeof evalScriptFor(RESERVE_LUA), "function");
  assert.equal(typeof evalScriptFor(CREATE_TENANT_LUA), "function");
  assert.equal(evalScriptFor("return 1"), undefined);
  for (const f of ["../cloud/meter/index.mjs", "../cloud/tenants/index.mjs"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/from\s+["'][^"']*memory-redis/.test(src), `${f} must not import memory-redis`);
  }
});
