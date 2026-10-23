// Vercel Cron path for the daily dogfood check: auth (401/503), idempotency
// per UTC day, the Redis scorecard read path, and gate math. In-memory Redis only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { createHandler, cronAuthorized, dogfoodSpaces } from "../api/cron/dogfood-check.mjs";
import { buildScorecard } from "../api/scorecard.mjs";
import { runDaily, gate, scorecardKey, DAY_MS } from "../scripts/dogfood-check.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";

const SECRET = "test-only-cron-secret-0123456789abcdef0123456789";
const ENV = { CRON_SECRET: SECRET, LOGMEM_DOGFOOD_SPACES: "madez,fieldnotes" };
const AUTH = { authorization: `Bearer ${SECRET}` };
// 01:00 UTC today, so "+3h" stays on the same UTC day and the 30-day read window holds.
const T0 = Math.floor(Date.now() / 864e5) * 864e5 + 3600e3;
const D = (i = 0) => new Date(T0 + i * 864e5).toISOString().slice(0, 10);
const quiet = () => {};
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;

async function team(redis, space) {
  const mirror = space === "madez" ? { enabled: true, spaces: ["madez"] } : { enabled: false, spaces: [] };
  const mk = (sid, surface) => createLogmem({ redis, space, sessionId: `${space}-${sid}`, surface, mirror, compat: true });
  const a = mk("a", "claude-code"), b = mk("b", "grok-local"), c = mk("c", "claude-code");
  await sc(a, "logmem_start", { agent: "claude-code" });
  await sc(b, "logmem_start", { agent: "grok-local" });
  await sc(c, "logmem_start", { agent: "claude-engineer" });
  return { a, b, c };
}

const call = async (handler, headers = {}, method = "GET") => {
  const res = mockRes();
  await handler(mockReq({ method, url: "/api/cron/dogfood-check", headers }), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, res };
};

const checkups = async (redis, space) =>
  (await redis("ZRANGE", `lm:${space}:job:logmem-dogfood:log`, 0, -1)).map(JSON.parse).filter((e) => e.kind === "checkup");

test("cron auth: CRON_SECRET unset or short -> 503, nothing runs", async () => {
  const redis = createMemoryRedis();
  for (const env of [{}, { CRON_SECRET: "" }, { CRON_SECRET: "short" }]) {
    const h = createHandler({ env, resolveRedis: () => redis, sink: quiet });
    const r = await call(h, AUTH);
    assert.equal(r.status, 503);
    assert.equal(r.res.headers["cache-control"], "no-store");
  }
  assert.equal(redis._data.size, 0, "fail closed: no writes");
});

test("cron auth: missing, wrong, or non-Bearer header -> 401, nothing runs", async () => {
  const redis = createMemoryRedis();
  const h = createHandler({ env: ENV, resolveRedis: () => redis, sink: quiet });
  for (const headers of [{}, { authorization: "" }, { authorization: "Bearer nope" }, { authorization: SECRET }, { authorization: `Basic ${SECRET}` }, { authorization: `Bearer ${SECRET}x` }]) {
    const r = await call(h, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(r.body, { error: "unauthorized" });
  }
  assert.equal(redis._data.size, 0);
  assert.equal(cronAuthorized({ headers: AUTH }, SECRET), true);
  assert.equal(cronAuthorized({ headers: {} }, SECRET), false);
});

test("cron run: both spaces checked, checkup by agent:logmem-check, scorecard in Redis", async () => {
  const redis = createMemoryRedis();
  const { a, b } = await team(redis, "madez");
  await team(redis, "fieldnotes");
  const ho = await sc(a, "logmem_handoff", { to: "grok-local", where: "job:logmem-v0-ship", summary: "review" });
  await sc(b, "logmem_accept", { trail: ho.trail, reason: "on it" });
  const h = createHandler({ env: ENV, resolveRedis: () => redis, now: () => Date.now(), sink: quiet });
  const r = await call(h, AUTH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.space), ["madez", "fieldnotes"]);
  assert.equal(r.body.results[0].pass, true);
  for (const space of ["madez", "fieldnotes"]) {
    const c = await checkups(redis, space);
    assert.equal(c.length, 1);
    assert.equal(c[0].by, "agent:logmem-check");
    assert.equal(c[0].trail, `dogfoodCheck-${c[0].payload.date}`);
    const card = JSON.parse(await redis("GET", scorecardKey(space)));
    assert.equal(card.by, "agent:logmem-check");
    assert.equal(card.space, space);
    assert.equal(card.days.length, 1);
    assert.ok(card.gate && card.gate.pass === false, "1 day is not 7");
  }
  assert.equal((await checkups(redis, "madez"))[0].payload.mirror_checked, true);
  assert.equal((await checkups(redis, "fieldnotes"))[0].payload.mirror_checked, false);
});

test("idempotent per UTC day: a second run replaces the day, no duplicate checkup (lm or ACMI)", async () => {
  const redis = createMemoryRedis();
  await team(redis, "madez");
  const h1 = createHandler({ env: { ...ENV, LOGMEM_DOGFOOD_SPACES: "madez" }, resolveRedis: () => redis, now: () => T0, sink: quiet });
  const h2 = createHandler({ env: { ...ENV, LOGMEM_DOGFOOD_SPACES: "madez" }, resolveRedis: () => redis, now: () => T0 + 3 * 3600e3, sink: quiet });
  assert.equal((await call(h1, AUTH)).body.results[0].replaced, 0);
  const second = await call(h2, AUTH);
  assert.equal(second.status, 200);
  assert.equal(second.body.results[0].replaced, 1);
  const c = await checkups(redis, "madez");
  assert.equal(c.length, 1, "one checkup for the day");
  assert.equal(c[0].ts, T0 + 3 * 3600e3, "the later run wins");
  const acmi = (await redis("ZRANGE", "acmi:madez:work:logmem-dogfood:timeline", 0, -1)).map(JSON.parse);
  assert.equal(acmi.length, 1, "ACMI twin replaced too");
  assert.equal(acmi[0].timestamp ?? acmi[0].ts, T0 + 3 * 3600e3);
  const card = JSON.parse(await redis("GET", scorecardKey("madez")));
  assert.deepEqual(card.days.map((d) => d.date), [D(0)]);

  // A new UTC day adds a row and a checkup.
  const h3 = createHandler({ env: { ...ENV, LOGMEM_DOGFOOD_SPACES: "madez" }, resolveRedis: () => redis, now: () => T0 + DAY_MS, sink: quiet });
  assert.equal((await call(h3, AUTH)).body.results[0].replaced, 0);
  assert.equal((await checkups(redis, "madez")).length, 2);
  assert.deepEqual(JSON.parse(await redis("GET", scorecardKey("madez"))).days.map((d) => d.date), [D(0), D(1)]);
});

test("overlapping runs: the lock makes the second one skip", async () => {
  const redis = createMemoryRedis();
  await team(redis, "fieldnotes");
  await redis("SET", "lm:fieldnotes:dogfood:lock", "someone-else", "NX", "EX", "600");
  const r = await runDaily(redis, { space: "fieldnotes", now: T0 });
  assert.deepEqual(r, { space: "fieldnotes", skipped: "locked" });
  assert.equal((await checkups(redis, "fieldnotes")).length, 0);
  await redis("DEL", "lm:fieldnotes:dogfood:lock");
  assert.equal((await runDaily(redis, { space: "fieldnotes", now: T0 })).date, D(0));
  assert.equal(await redis("GET", "lm:fieldnotes:dogfood:lock"), null, "own lock released");
});

test("errors: generic 500 with a ref, no detail leaked; bad config; no backend -> 503", async () => {
  const boom = async () => { throw new Error("secret-ish backend detail https://bridge.internal"); };
  const lines = [];
  const h = createHandler({ env: ENV, resolveRedis: () => boom, sink: (l) => lines.push(l) });
  const r = await call(h, AUTH);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "internal error");
  assert.match(r.body.ref, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(r.body), /bridge|secret/);
  assert.ok(lines.some((l) => l.includes(r.body.ref)), "detail goes to the log under the same ref");

  const bad = await call(createHandler({ env: { ...ENV, LOGMEM_DOGFOOD_SPACES: "madez,Bad:Space" }, resolveRedis: () => createMemoryRedis(), sink: quiet }), AUTH);
  assert.equal(bad.status, 500);
  assert.equal(bad.body.error, "internal error");
  assert.throws(() => dogfoodSpaces({ LOGMEM_DOGFOOD_SPACES: "a:b" }));
  assert.deepEqual(dogfoodSpaces({}), ["madez", "fieldnotes"]);

  const none = await call(createHandler({ env: ENV, resolveRedis: () => null, sink: quiet }), AUTH);
  assert.equal(none.status, 503);
});

test("blank LOGMEM_DOGFOOD_SPACES is unset and checks the default spaces", async () => {
  for (const v of ["", "   ", "\n\t", " , , "]) {
    assert.deepEqual(dogfoodSpaces({ LOGMEM_DOGFOOD_SPACES: v }), ["madez", "fieldnotes"], JSON.stringify(v));
  }
  assert.deepEqual(dogfoodSpaces({ LOGMEM_DOGFOOD_SPACES: "madez" }), ["madez"], "an explicit list is kept");
  const redis = createMemoryRedis();
  const h = createHandler({
    env: { CRON_SECRET: SECRET, LOGMEM_DOGFOOD_SPACES: "   " },
    resolveRedis: () => redis,
    now: () => T0,
    sink: quiet,
  });
  const r = await call(h, AUTH);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.space), ["madez", "fieldnotes"]);
  assert.equal(r.body.results.every((x) => x.date === D(0)), true);
  for (const space of ["madez", "fieldnotes"]) assert.equal((await checkups(redis, space)).length, 1);
});

test("scorecard read path: Redis first, trust rule kept, gate recomputed, checkups fallback", async () => {
  const redis = createMemoryRedis();
  await team(redis, "madez");
  // Fallback: no Redis scorecard yet, only checkups.
  await runDaily(redis, { space: "madez", now: T0 });
  await redis("DEL", scorecardKey("madez"));
  let card = await buildScorecard(redis, "madez");
  assert.equal(card.source, "checkups");
  assert.deepEqual(card.days.map((d) => d.date), [D(0)]);

  // Redis present: its row wins for a trusted date; a row with no trusted
  // checkup is dropped; a forged gate is ignored.
  await runDaily(redis, { space: "madez", now: T0 + 3600e3 });
  const stored = JSON.parse(await redis("GET", scorecardKey("madez")));
  stored.days[0].entries = 4242;
  stored.days.push({ ...stored.days[0], date: D(-1), pass: true });
  stored.gate = { pass: true, days_passing: 7, consecutive: true, deliverable_done: true };
  await redis("SET", scorecardKey("madez"), JSON.stringify(stored));
  card = await buildScorecard(redis, "madez");
  assert.equal(card.source, "redis");
  assert.deepEqual(card.days.map((d) => d.date), [D(0)], "untrusted date dropped");
  assert.equal(card.days[0].entries, 4242, "the Redis row is the one shown");
  assert.equal(card.gate.pass, false, "gate recomputed, not read");
  assert.equal(card.deliverable.stage, "missing", "deliverable read live");

  // A scorecard not written by the check is ignored entirely.
  await redis("SET", scorecardKey("madez"), JSON.stringify({ ...stored, by: "agent:mallory" }));
  card = await buildScorecard(redis, "madez");
  assert.equal(card.source, "checkups");
  assert.notEqual(card.days[0].entries, 4242);

  // Garbage in the key falls back too.
  await redis("SET", scorecardKey("madez"), "not json");
  assert.equal((await buildScorecard(redis, "madez")).source, "checkups");

  // The read path writes nothing.
  const before = JSON.stringify([...redis._data.keys()].sort());
  await buildScorecard(redis, "madez");
  assert.equal(JSON.stringify([...redis._data.keys()].sort()), before);
});

test("gate math unchanged over 7 cron days: needs 7 consecutive passes + deliverable done", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "fieldnotes" });
  await team(redis, "fieldnotes");
  let last;
  for (let i = 0; i < 7; i++) last = await runDaily(redis, { space: "fieldnotes", mirrorSpaces: [], now: T0 + i * DAY_MS });
  assert.equal(last.card.days.length, 7);
  // Days fail on volume (no handoffs in the window), so the gate fails.
  assert.equal(last.card.gate.consecutive, true);
  assert.equal(last.card.gate.pass, false);
  // Same card with all days passing and the deliverable done: the old gate passes.
  const ok = { ...last.card, days: last.card.days.map((d) => ({ ...d, pass: true })), deliverable: { stage: "done" } };
  assert.deepEqual(gate(ok), { days_passing: 7, consecutive: true, deliverable_done: true, pass: true });
  // A gap breaks "consecutive".
  const gap = { ...ok, days: ok.days.map((d, i) => (i === 6 ? { ...d, date: D(8) } : d)) };
  assert.equal(gate(gap).consecutive, false);
  assert.equal(gate(gap).pass, false);
  // The page agrees once the deliverable is done and days pass.
  await store.setNow("job", "logmem-v0-ship", { stage: "done" });
  const page = await buildScorecard(redis, "fieldnotes");
  assert.equal(page.source, "redis");
  assert.equal(page.days.length, 7);
  assert.equal(page.gate.deliverable_done, true);
  assert.equal(page.gate.pass, false, "real days still fail volume");
});

test("vercel.json: daily crons (dogfood 13:00, reconcile 13:30 UTC); headers and rewrites intact", async () => {
  const { readFileSync } = await import("node:fs");
  const v = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  // Daily only: a sub-daily schedule fails deploys on plans that don't allow it.
  assert.deepEqual(v.crons, [{ path: "/api/cron/dogfood-check", schedule: "0 13 * * *" }, { path: "/api/cron/reconcile", schedule: "30 13 * * *" }]);
  assert.ok(v.rewrites.some((r) => r.source === "/mcp"));
  assert.ok(v.headers.some((h) => h.source === "/(.*)"));
});
