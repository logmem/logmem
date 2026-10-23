import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { mirrorConfigFromEnv } from "../src/core/mirror.mjs";

const ON = { enabled: true, spaces: ["madez"] };
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;

test("env config: off by default, madez by default when on", () => {
  assert.deepEqual(mirrorConfigFromEnv({}), { enabled: false });
  assert.equal("spaces" in mirrorConfigFromEnv({}), false);
  assert.deepEqual(mirrorConfigFromEnv({ LOGMEM_MIRROR_ACMI: "1" }), { enabled: true, spaces: ["madez"] });
  assert.deepEqual(mirrorConfigFromEnv({ LOGMEM_MIRROR_ACMI: "1", LOGMEM_MIRROR_SPACES: "a,b" }), { enabled: true, spaces: ["a", "b"] });
});

test("log writes get an ACMI twin: ACMI fields + kind, ms score, mirrored_from", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", compat: true, sessionId: "m1", surface: "claude-code", mirror: ON });
  await sc(lm, "logmem_start", { agent: "claude-code" });
  const r = await sc(lm, "logmem_handoff", { to: "bentley", where: "job:logmem-v0-ship", summary: "review spec", create_agent: true });
  assert.equal(r.mirror, "ok");
  const job = await redis("ZRANGE", "acmi:madez:work:logmem-v0-ship:timeline", 0, -1, "WITHSCORES");
  const twin = JSON.parse(job[0]);
  assert.equal(twin.kind, "handoff");
  assert.equal(twin.source, "agent:claude-code");
  assert.equal(twin.correlationId, r.trail);
  assert.equal(twin.mirrored_from, "lm");
  assert.equal("_o" in twin, false);
  assert.equal(String(job[1]).length, 13, "ms score");
  assert.equal((await redis("ZCARD", "acmi:madez:agent:bentley:timeline")), 1, "receiver's ACMI log too");
  assert.deepEqual(await redis("SMEMBERS", "acmi:madez:work:list"), ["logmem-v0-ship"]);
});

test("compat reads show a mirrored entry once", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "madez", compat: true, sessionId: "m2", mirror: ON });
  await sc(lm, "logmem_start", { agent: "a" });
  await sc(lm, "logmem_note", { where: "channel:ops", summary: "only once" });
  const view = await sc(lm, "logmem_view", { ref: "channel:ops" });
  assert.equal(view.log.filter((e) => e.summary === "only once").length, 1);
});

test("now merges into ACMI signals (string or hash); who overwrites profile", async () => {
  const redis = createMemoryRedis();
  await redis("SET", "acmi:madez:agent:a:signals", JSON.stringify({ acmi_only: true }));
  await redis("HSET", "acmi:madez:agent:b:signals", "old", "1");
  const lm = createLogmem({ redis, space: "madez", sessionId: "m3", mirror: ON });
  await sc(lm, "logmem_start", { agent: "a" });
  await sc(lm, "logmem_status", { agent: "a", now: { doing: "x" } });
  // Agents only change their own Now, so b writes b's.
  const lmB = createLogmem({ redis, space: "madez", sessionId: "m3b", mirror: ON });
  await sc(lmB, "logmem_start", { agent: "b" });
  await sc(lmB, "logmem_status", { now: { doing: "y", n: { k: 1 } } });
  const a = JSON.parse(await redis("GET", "acmi:madez:agent:a:signals"));
  assert.equal(a.acmi_only, true);
  assert.equal(a.doing, "x");
  assert.equal(await redis("HGET", "acmi:madez:agent:b:signals", "doing"), "y");
  assert.equal(await redis("HGET", "acmi:madez:agent:b:signals", "n"), '{"k":1}');
  await sc(lm, "logmem_bio", { agent: "a", who: { role: "builder" } });
  assert.equal(JSON.parse(await redis("GET", "acmi:madez:agent:a:profile")).role, "builder");
});

test("mirror failure: tool still ok, reports failed, queues; next call drains", async () => {
  const base = createMemoryRedis();
  let breakAcmi = true;
  const redis = async (cmd, ...args) => {
    if (breakAcmi && String(args[0] || "").startsWith("acmi:") && cmd !== "TYPE") throw new Error("bridge refused");
    return base(cmd, ...args);
  };
  const lm = createLogmem({ redis, space: "madez", sessionId: "m4", mirror: ON });
  await sc(lm, "logmem_start", { agent: "a" });
  const r = await sc(lm, "logmem_note", { where: "channel:ops", summary: "survives" });
  assert.equal(r.ok, true);
  assert.equal(r.mirror, "failed");
  assert.ok((await lm.store.mirror.pending()) >= 1);
  assert.equal(await base("ZCARD", "lm:madez:channel:ops:log"), 1, "lm write landed");
  breakAcmi = false;
  await sc(lm, "logmem_view", { ref: "channel:ops" });
  assert.equal(await lm.store.mirror.pending(), 0, "drained");
  assert.equal(await base("ZCARD", "acmi:madez:thread:ops:timeline"), 1);
});

test("space filter: no mirror outside LOGMEM_MIRROR_SPACES, and off when disabled", async () => {
  const redis = createMemoryRedis();
  const sand = createLogmem({ redis, space: "fieldnotes", sessionId: "m5", mirror: ON });
  await sc(sand, "logmem_start", { agent: "quill" });
  const r = await sc(sand, "logmem_note", { where: "channel:x", summary: "sandbox" });
  assert.equal(r.mirror, undefined);
  const off = createLogmem({ redis, space: "madez", sessionId: "m6" });
  await sc(off, "logmem_start", { agent: "q" });
  await sc(off, "logmem_note", { where: "channel:y", summary: "plain" });
  assert.deepEqual(await redis("KEYS", "acmi:*"), []);
});
