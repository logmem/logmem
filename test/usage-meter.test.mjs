// Count-only usage meter for spaces without plan limits (job meter-every-op).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { createUsageMeter, readUsage, usageKey, usageMonth, meterOnFromEnv, USAGE_TTL_SECONDS } from "../src/core/usage-meter.mjs";

const SPACE = "fleet";
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis, opts = {}) =>
  createLogmem({ redis, space: SPACE, sessionId: "s1", surface: "test", defaultAgent: "muse", ...opts });

test("usage: each written entry is one add, and its agent is active this month", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  const u1 = await readUsage(redis, SPACE);
  assert.ok(u1.add >= 2, "the auto-started shift and the note both count");
  assert.equal(u1.agents, 1);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "two" });
  const u2 = await readUsage(redis, SPACE);
  assert.equal(u2.add, u1.add + 1);
});

test("usage: a recall counts once as a recall and never as a read", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "find the blue door" });
  const before = await readUsage(redis, SPACE);
  const r = await sc(lm, "logmem_recall", { query: "blue door" });
  assert.equal(r.ok, true);
  const after = await readUsage(redis, SPACE);
  assert.equal(after.recall, before.recall + 1);
  assert.equal(after.read, before.read);
});

test("usage: the compat recall counts as a recall too", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis, { compat: true });
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "find the blue door" });
  const before = await readUsage(redis, SPACE);
  await sc(lm, "acmi_search_semantic", { query: "blue door" });
  const after = await readUsage(redis, SPACE);
  assert.equal(after.recall, before.recall + 1);
  assert.equal(after.read, before.read);
});

test("usage: each read-only tool call is one read; writes are not reads", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  const before = await readUsage(redis, SPACE);
  await sc(lm, "logmem_view", { ref: "channel:ideas" });
  await sc(lm, "logmem_brief", {});
  const after = await readUsage(redis, SPACE);
  assert.equal(after.read, before.read + 2);
  assert.equal(after.ops_total, before.ops_total + 2 + (after.add - before.add));
});

test("usage: a failed read is not counted", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  const before = await readUsage(redis, SPACE);
  const r = await sc(lm, "logmem_view", { ref: "job:" });
  assert.equal(r.ok, false);
  assert.equal((await readUsage(redis, SPACE)).read, before.read);
});

test("usage: a broken counter never fails the tool call", async () => {
  const inner = createMemoryRedis();
  const redis = (cmd, ...args) => {
    if (String(args[0] || "").includes(":usage:")) throw new Error("bridge refused");
    return inner(cmd, ...args);
  };
  const lm = lmFor(redis);
  const r = await sc(lm, "logmem_note", { where: "channel:ideas", summary: "still works" });
  assert.equal(r.ok, true);
  const rec = await sc(lm, "logmem_recall", { query: "works" });
  assert.equal(rec.ok, true);
});

test("usage: LOGMEM_METER=off and meter:false turn it off", async () => {
  assert.equal(meterOnFromEnv({}), true);
  assert.equal(meterOnFromEnv({ LOGMEM_METER: "off" }), false);
  assert.equal(meterOnFromEnv({ LOGMEM_METER: "0" }), false);
  assert.equal(meterOnFromEnv({ LOGMEM_METER: "on" }), true);
  const redis = createMemoryRedis();
  const lm = lmFor(redis, { meter: false });
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  await sc(lm, "logmem_recall", { query: "one" });
  const u = await readUsage(redis, SPACE);
  assert.equal(u.ops_total, 0);
});

test("usage: a managed account uses its plan meter, not a second count", async () => {
  const redis = createMemoryRedis();
  const T = "uabcdefghij";
  const space = `t-${T}`;
  const limits = createLimits({ redis, tenant: T, plan: "free" });
  const lm = createLogmem({ redis, space, sessionId: "s1", surface: "muse", defaultAgent: "muse", lockedAgent: "muse", limits });
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  await sc(lm, "logmem_recall", { query: "one" });
  assert.equal((await readUsage(redis, space)).ops_total, 0);
});

test("usage: counters are per UTC month with a 400-day TTL", async () => {
  const calls = [];
  const inner = createMemoryRedis();
  const redis = (cmd, ...args) => {
    calls.push([cmd, ...args]);
    return inner(cmd, ...args);
  };
  const at = Date.UTC(2026, 9, 31, 23, 59);
  const m = createUsageMeter(redis, SPACE, { now: () => at });
  await m.count("recall");
  await m.agent("agent:quill");
  await m.agent("human:mikey");
  await m.count("bogus");
  assert.equal(usageMonth(at), "202610");
  assert.deepEqual(await readUsage(inner, SPACE, { month: "202610" }), {
    space: SPACE, month: "202610", add: 0, read: 0, recall: 1, ops_total: 1, agents: 1,
  });
  const ttl = calls.filter(([c]) => c === "EXPIRE").map(([, k, s]) => [k, s]);
  assert.ok(ttl.some(([k, s]) => k === usageKey(SPACE, "202610", "recall") && s === USAGE_TTL_SECONDS));
  assert.ok(ttl.some(([k]) => k === usageKey(SPACE, "202610", "agents")));
  await assert.rejects(readUsage(inner, SPACE, { month: "2026-10" }), /invalid_month/);
});

test("usage: agents cannot remove usage counters", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  const key = usageKey(SPACE, usageMonth(), "add");
  const r = await sc(lm, "logmem_remove", { key, confirm: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /protected/);
  assert.ok((await readUsage(redis, SPACE)).add > 0);
});
