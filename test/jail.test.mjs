// The customer Redis jail (one-click connect plan, task 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createJail, tenantSpace, customerRedisUri, JailError, CustomerRedisConfigError } from "../src/http/jail.mjs";
import { createLogmem } from "../src/server.mjs";

const T = "uabcdefghij";
const P = `lm:t-${T}:`;

function spy() {
  const base = createMemoryRedis();
  const calls = [];
  const r = async (...c) => { calls.push(c); return base(...c); };
  r.calls = calls;
  return r;
}

test("jail: keys inside the space pass, keys outside are refused without touching Redis", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  assert.equal(j.space, `t-${T}`);
  assert.equal(await j("SET", `${P}a`, "1"), "OK");
  assert.equal(await j("GET", `${P}a`), "1");
  for (const key of ["lm:madez:agent:atlas:log", "lm:oauth:client:x", "acmi:cloud:tenant:x", `lm:t-${T}`, "lm:t-uother1234:x", `${P}`]) {
    await assert.rejects(() => j("GET", key), JailError, key);
  }
  assert.equal(redis.calls.length, 2, "refused commands never reach Redis");
});

test("jail: every key of a multi-key command is checked", async () => {
  const j = createJail(spy(), T);
  await assert.rejects(() => j("DEL", `${P}a`, "lm:madez:x"), JailError);
  await assert.rejects(() => j("MGET", `${P}a`, "lm:oauth:at:x"), JailError);
  await assert.rejects(() => j("RENAME", `${P}a`, "lm:madez:x"), JailError);
  assert.equal(await j("DEL", `${P}a`, `${P}b`), 0);
});

test("jail: SCAN is forced into the space, and a MATCH outside it is refused", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  await j("SCAN", "0");
  assert.deepEqual(redis.calls.at(-1).slice(0, 4), ["SCAN", "0", "MATCH", `${P}*`]);
  await j("SCAN", "0", "MATCH", `${P}agent:*`);
  assert.equal(redis.calls.at(-1)[3], `${P}agent:*`);
  await assert.rejects(() => j("SCAN", "0", "MATCH", "lm:*"), JailError);
  await assert.rejects(() => j("SCAN", "0", "MATCH", "*"), JailError);
});

test("jail: scripting, admin and KEYS commands are refused, and errors name nothing", async () => {
  const j = createJail(spy(), T);
  for (const cmd of [["EVAL", "return 1", "0"], ["EVALSHA", "abc", "0"], ["SCRIPT", "LOAD", "x"], ["FLUSHALL"], ["FLUSHDB"], ["CONFIG", "GET", "*"], ["CLIENT", "LIST"], ["MODULE", "LIST"], ["MONITOR"], ["SELECT", "1"], ["MIGRATE", "h", "1", `${P}a`, "0", "1"], ["DEBUG", "SLEEP", "0"], ["KEYS", `${P}*`], ["NOTACOMMAND", `${P}a`]]) {
    await assert.rejects(() => j(...cmd), (e) => {
      assert.ok(e instanceof JailError, cmd[0]);
      assert.equal(e.message, "jail: command not allowed");
      return true;
    });
  }
});

test("jail: an invalid or reserved tenant id is refused up front", () => {
  for (const bad of ["madez", "oauth", "A", "x", "../x", "", null]) assert.throws(() => createJail(spy(), bad), String(bad));
  assert.equal(tenantSpace(T), `t-${T}`);
});

test("jail: a full LogMem session runs inside the space and writes nowhere else", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  const lm = createLogmem({ redis: j, space: tenantSpace(T), sessionId: "s1", surface: "muse", lockedAgent: "muse", defaultAgent: "muse" });
  const sc = async (n, a) => (await lm.callTool(n, a)).structuredContent;
  assert.equal((await sc("logmem_start", { agent: "muse" })).ok, true);
  assert.equal((await sc("logmem_note", { where: "channel:ideas", summary: "first note" })).ok, true);
  assert.equal((await sc("logmem_assign", { job: "plan", title: "Plan the week" })).ok, true);
  assert.equal((await sc("logmem_update", { job: "plan", summary: "drafted" })).ok, true);
  assert.equal((await sc("logmem_brief", {})).ok, true);
  assert.equal((await sc("logmem_feed", { refs: ["channel:ideas", "job:plan"] })).ok, true);
  assert.equal((await sc("logmem_recap", { notes: "done for now" })).ok, true);
  const touched = redis.calls.flatMap((c) => c.slice(1).filter((a) => typeof a === "string" && a.startsWith("lm:")));
  assert.ok(touched.length > 10, "the session wrote real keys");
  for (const k of touched) assert.ok(k.startsWith(P), `outside the jail: ${k}`);
});

test("customer Redis URI: required, TLS only outside local dev", () => {
  assert.throws(() => customerRedisUri({ VERCEL_ENV: "production" }), CustomerRedisConfigError);
  assert.throws(() => customerRedisUri({ VERCEL_ENV: "production", LOGMEM_CUSTOMER_REDIS_URI: "redis://u:p@h:6379" }), /rediss:\/\//);
  assert.equal(customerRedisUri({ VERCEL_ENV: "production", LOGMEM_CUSTOMER_REDIS_URI: "rediss://u:p@h:6380" }), "rediss://u:p@h:6380");
  assert.equal(customerRedisUri({ NODE_ENV: "test", LOGMEM_CUSTOMER_REDIS_URI: "redis://localhost:6379" }), "redis://localhost:6379");
});
