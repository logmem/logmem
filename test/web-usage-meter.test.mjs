import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { readUsage } from "../src/core/usage-meter.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/work.mjs";

const SPACE = "madez";
const ENV = {
  LOGMEM_ADMIN_PASSWORD: "test-web-meter-password", LOGMEM_ADMIN_ID: "mikey",
  LOGMEM_VIEW_SPACES: SPACE, LOGMEM_MIRROR_ACMI: "1", LOGMEM_MIRROR_SPACES: SPACE,
};
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function setup({ redis = createMemoryRedis(), env = ENV } = {}) {
  const store = createStore(redis, { space: SPACE });
  await store.setWho("job", "ship", { title: "Ship", owner: "agent:muse" });
  await store.setWho("agent", "muse", { name: "Muse" });
  const handler = createHandler({ redis, env });
  const call = async (method, url, body) => {
    const res = response();
    await handler({ method, url, body, headers: { cookie: issueCookie(env).split(";")[0], "x-logmem-intent": "work" } }, res);
    return res;
  };
  const nudge = () => call("POST", "/api/work?op=nudge", { space: SPACE, job: "ship", note: "Please review" });
  return { redis, store, call, nudge };
}

test("web usage: a nudge counts both written entries and keeps their ACMI twins", async () => {
  const { redis, nudge, store } = await setup();
  const res = await nudge();
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal((await store.readLog("job", "ship")).length, 1);
  assert.equal((await store.readLog("agent", "muse")).length, 1);
  const usage = await readUsage(redis, SPACE);
  assert.equal(usage.add, 2);
  assert.equal(usage.ops_total, 2);
  assert.equal(usage.agents, 0, "a human nudge does not mark its recipient as an active writer");
  assert.equal(await redis("ZCARD", "acmi:madez:work:ship:timeline"), 1);
  assert.equal(await redis("ZCARD", "acmi:madez:agent:muse:timeline"), 1);
});

test("web usage: LOGMEM_METER=off skips counters while writes and mirrors still work", async () => {
  const { redis, nudge } = await setup({ env: { ...ENV, LOGMEM_METER: "off" } });
  assert.equal((await nudge()).code, 200);
  assert.equal((await readUsage(redis, SPACE)).ops_total, 0);
  assert.equal(await redis("ZCARD", "lm:madez:job:ship:log"), 1);
  assert.equal(await redis("ZCARD", "acmi:madez:work:ship:timeline"), 1);
});

test("web usage: a counter failure does not fail a successful web write", async () => {
  const inner = createMemoryRedis();
  const redis = (cmd, ...args) => {
    if (String(args[0] || "").includes(":usage:")) throw new Error("counter unavailable");
    return inner(cmd, ...args);
  };
  const { nudge } = await setup({ redis });
  assert.equal((await nudge()).code, 200);
  assert.equal(await inner("ZCARD", "lm:madez:job:ship:log"), 1);
  assert.equal(await inner("ZCARD", "acmi:madez:work:ship:timeline"), 1);
});

test("web usage: rejected writes and read-only polls do not count as adds", async () => {
  const { redis, call } = await setup();
  assert.equal((await call("POST", "/api/work?op=nudge", { space: SPACE, job: "missing" })).code, 404);
  assert.equal((await call("GET", "/api/work?op=pulse&space=madez")).code, 200);
  assert.equal((await call("GET", "/api/work?op=needs&space=madez")).code, 200);
  assert.equal((await readUsage(redis, SPACE)).ops_total, 0);
});
