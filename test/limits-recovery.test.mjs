import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { monthKey } from "../cloud/meter/index.mjs";

const tenant = "uabcdefghij", space = `t-${tenant}`;
const countKey = () => `acmi:cloud:meter:${tenant}:${monthKey(Date.now())}:add`;
const make = (redis, agent = "muse") => createLogmem({ redis, space, sessionId: agent, defaultAgent: agent, lockedAgent: agent, limits: createLimits({ redis, tenant, plan: "free" }) });
const call = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

test("recovered limits: quota refusal cannot create or complete a job", async () => {
  const redis = createMemoryRedis(), lm = make(redis);
  assert.equal((await call(lm, "logmem_assign", { job: "existing", title: "Existing" })).ok, true);
  const before = await lm.store.getNow("job", "existing");
  await redis("SET", countKey(), "1100");
  assert.equal((await call(lm, "logmem_assign", { job: "denied", title: "Denied" })).ok, false);
  assert.equal(await lm.store.getWho("job", "denied"), null);
  assert.deepEqual(await lm.store.getNow("job", "denied"), {});
  assert.equal((await call(lm, "logmem_stage", { job: "existing", stage: "done" })).ok, false);
  assert.deepEqual(await lm.store.getNow("job", "existing"), before);
});

test("recovered limits: concurrent third-agent attempts never reserve a provisional slot", async () => {
  const redis = createMemoryRedis(), key = `lm:${space}:agents`;
  await redis("SADD", key, "muse", "atlas");
  let release, sawProvisional;
  const gate = new Promise(resolve => { release = resolve; });
  const provisional = new Promise(resolve => { sawProvisional = resolve; });
  const delayed = async (...cmd) => {
    const result = await redis(...cmd);
    if (cmd[0] === "SADD" && cmd[1] === key && cmd[2] === "nova") {
      sawProvisional();
      await gate;
    }
    return result;
  };
  const first = createLimits({ redis: delayed, tenant, plan: "free" }).agentSlot("nova");
  await Promise.race([provisional, first.catch(() => {})]);
  const second = await Promise.allSettled([createLimits({ redis, tenant, plan: "free" }).agentSlot("nova")]);
  release();
  const results = [...await Promise.allSettled([first]), ...second];
  assert.ok(results.every(r => r.status === "rejected"));
  assert.equal(await redis("SCARD", key), 2);
  assert.equal(await redis("SISMEMBER", key, "nova"), 0);
});

test("recovered limits: injected recall receives the history floor and cannot return expired or undated rows", async () => {
  const redis = createMemoryRedis(), time = Date.now();
  let options;
  const lm = createLogmem({ redis, space, sessionId: "recall", lockedAgent: "muse", limits: createLimits({ redis, tenant, plan: "free", now: () => time }), recall: async (_q, _n, opts) => {
    options = opts;
    return { mode: "semantic", results: [{ ts: time - 10 * 864e5, summary: "Old" }, { ts: time, summary: "Current" }, { summary: "Unknown" }] };
  } });
  const result = await call(lm, "logmem_recall", { query: "work" });
  assert.deepEqual(options, { sinceMs: time - 7 * 864e5 });
  assert.deepEqual(result.results, [{ ts: time, summary: "Current" }]);
});

test("recovered limits: rejected lifecycle entries leave no new slot or recap", async () => {
  const redis = createMemoryRedis();
  await redis("SET", countKey(), "1100");
  const before = structuredClone(redis._data);
  assert.equal((await call(make(redis, "nova"), "logmem_assign", { job: "denied", title: "Denied" })).ok, false);
  assert.deepEqual(redis._data, before);
  await redis("SET", countKey(), "0");
  const lm = make(redis);
  await call(lm, "logmem_note", { where: "channel:work", summary: "Started" });
  await redis("SET", countKey(), "1100");
  assert.equal((await call(lm, "logmem_recap", { notes: "Denied" })).ok, false);
  assert.equal(await lm.store.getRecap("muse"), null);
});


test("recovered limits: denied assignment cannot create the default plan", async () => {
  const redis = createMemoryRedis(), lm = make(redis);
  await call(lm, "logmem_start", { agent: "muse" });
  assert.equal(await redis("GET", `lm:${space}:plan:general`), null);
  await redis("SET", countKey(), "1100");
  assert.equal((await call(lm, "logmem_assign", { job: "denied", title: "Denied" })).ok, false);
  assert.equal(await redis("GET", `lm:${space}:plan:general`), null);
  assert.deepEqual(await redis("SMEMBERS", `lm:${space}:plan:list`), []);
});
