// Free limits for managed accounts (one-click connect plan, task 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { monthKey } from "../cloud/meter/index.mjs";

const T = "uabcdefghij";
const SPACE = `t-${T}`;
const DAY = 864e5;
const counter = (op = "add") => `acmi:cloud:meter:${T}:${monthKey(Date.now())}:${op}`;

function lmFor(redis, { agent = "muse", plan = "free", session = agent } = {}) {
  const limits = createLimits({ redis, tenant: T, plan });
  return createLogmem({ redis, space: SPACE, sessionId: session, surface: agent, defaultAgent: agent, lockedAgent: agent, limits });
}
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;

test("limits: each written entry is one add, counted on the meter", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "one" });
  const n = Number(await redis("GET", counter()));
  assert.equal(n, 2, "the managed start and note both pass write admission and count");
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "two" });
  assert.equal(Number(await redis("GET", counter())), n + 1);
});

test("limits: Free writes stop after the 10% grace, reads keep working", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "before the limit" });
  await redis("SET", counter(), "1099"); // limit 1,000 plus 10% grace = 1,100
  assert.equal((await sc(lm, "logmem_note", { where: "channel:ideas", summary: "the last one in grace" })).ok, true);
  const refused = await lm.callTool("logmem_note", { where: "channel:ideas", summary: "over" });
  assert.equal(refused.isError, true);
  assert.match(refused.structuredContent.error, /used its 1000 Free entries this month\. Reads still work/);
  const log = await redis("ZRANGE", `lm:${SPACE}:channel:ideas:log`, "0", "-1");
  assert.ok(!log.some((x) => x.includes('"over"')), "nothing was written");
  const view = await sc(lm, "logmem_view", { ref: "channel:ideas" });
  assert.equal(view.ok, true, "reads still work after the limit");
});

test("limits: two writes at the grace edge at once, only one passes", async () => {
  const redis = createMemoryRedis();
  const a = lmFor(redis, { session: "s-a" });
  await sc(a, "logmem_note", { where: "channel:ideas", summary: "warm up" });
  await redis("SET", counter(), "1099");
  const [x, y] = await Promise.all([1, 2].map((i) => a.callTool("logmem_note", { where: "channel:ideas", summary: `race ${i}` })));
  assert.equal([x, y].filter((r) => r.isError !== true).length, 1);
});

test("limits: Free allows 2 agents; the 3rd agent's writes are refused", async () => {
  const redis = createMemoryRedis();
  for (const agent of ["muse", "atlas"]) {
    assert.equal((await sc(lmFor(redis, { agent }), "logmem_note", { where: "channel:ideas", summary: `hi from ${agent}` })).ok, true, agent);
  }
  const third = await lmFor(redis, { agent: "nova" }).callTool("logmem_note", { where: "channel:ideas", summary: "me too" });
  assert.equal(third.isError, true);
  assert.match(JSON.stringify(third.structuredContent), /Free allows 2 agents/);
  assert.equal(Number(await redis("SCARD", `lm:${SPACE}:agents`)), 2, "the refused agent holds no slot");
  assert.equal((await sc(lmFor(redis, { agent: "atlas" }), "logmem_note", { where: "channel:ideas", summary: "still fine" })).ok, true);
});

test("limits: Free reads show the last 7 days; nothing is deleted; Dev shows them again", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "fresh" });
  const key = `lm:${SPACE}:channel:ideas:log`;
  const old = Date.now() - 10 * DAY;
  await redis("ZADD", key, String(old), JSON.stringify({ ts: old, kind: "memo", by: "agent:muse", trail: "old-1", summary: "ten days old" }));
  const before = Number(await redis("ZCARD", key));

  const freeView = JSON.stringify(await sc(lm, "logmem_view", { ref: "channel:ideas" }));
  const freeFeed = JSON.stringify(await sc(lm, "logmem_feed", { refs: ["channel:ideas"] }));
  assert.ok(freeView.includes("fresh") && !freeView.includes("ten days old"), "view hides old entries on Free");
  assert.ok(!freeFeed.includes("ten days old"), "feed hides old entries on Free");
  const freeRecall = await sc(lm, "logmem_recall", { query: "ten days old" });
  assert.ok(!(freeRecall.results || []).some((r) => r.summary === "ten days old"), "recall hides old entries on Free");
  const freeBrief = JSON.stringify(await sc(lm, "logmem_brief", {}));
  assert.ok(!freeBrief.includes("ten days old"), "the Brief hides old entries on Free");
  assert.equal(Number(await redis("ZCARD", key)), before, "nothing is deleted");

  const dev = lmFor(redis, { plan: "dev", session: "dev" });
  assert.ok(JSON.stringify(await sc(dev, "logmem_view", { ref: "channel:ideas" })).includes("ten days old"), "Dev (30 days) shows it again");
});

test("limits: off for the fleet and self-hosted (no limits passed)", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "fleet", surface: "claude-code" });
  await sc(lm, "logmem_note", { where: "channel:ops", summary: "fleet note" });
  assert.equal((await redis("SCAN", "0", "MATCH", "acmi:cloud:meter:*"))[1].length, 0, "no meter keys");
});

test("limits: each recall counts; Free recall stops after 100 plus the 10% grace, other tools keep working", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_note", { where: "channel:ideas", summary: "river cleanup notes" });
  assert.equal((await sc(lm, "logmem_recall", { query: "river cleanup" })).ok, true);
  assert.equal(Number(await redis("GET", counter("recall"))), 1, "one recall, one count");
  await redis("SET", counter("recall"), "109"); // 100 plus 10% grace = 110
  assert.equal((await sc(lm, "logmem_recall", { query: "river" })).ok, true, "the last one in grace");
  const refused = await lm.callTool("logmem_recall", { query: "river" });
  assert.equal(refused.isError, true);
  assert.match(refused.structuredContent.error, /used its 100 Free recalls this month\. Notes, views and the Brief still work/);
  assert.equal((await sc(lm, "logmem_note", { where: "channel:ideas", summary: "still writing" })).ok, true, "notes still work");
  assert.equal((await sc(lm, "logmem_brief", {})).ok, true, "the Brief still works");
});

test("limits: recall is not counted without limits (the fleet and self-hosters)", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "x", defaultAgent: "codex" });
  for (let i = 0; i < 3; i++) assert.equal((await sc(lm, "logmem_recall", { query: "anything" })).ok, true);
  assert.equal(await redis("GET", counter("recall")), null);
});
