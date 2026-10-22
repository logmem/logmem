// Shift noise (job shift-noise-coalesce): stateless clients keep one shift,
// auto Starts are metadata, and empty shifts get no idle Recap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { monthKey } from "../cloud/meter/index.mjs";

const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
function clock(start = 1791712800000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}
const MIN = 60 * 1000;
// A stateless client: a fresh session id on every call (one process per call).
let n = 0;
const call = (redis, now, { surface = "logmem-exec", agent = "muse", space = "madez", ...o } = {}) =>
  createLogmem({ redis, space, sessionId: `stateless-${++n}`, surface, defaultAgent: agent, now, ...o });
const allEntries = async (redis, space = "madez") => {
  const out = [];
  for (const k of await redis("KEYS", `lm:${space}:*:log`)) for (const m of await redis("ZRANGE", k, 0, -1)) out.push(JSON.parse(m));
  return out;
};
const shifts = async (redis, agent, space = "madez") => (await redis("ZRANGE", `lm:${space}:agent:${agent}:shifts`, 0, -1)).map(JSON.parse);

test("10 stateless calls produce 1 shift and 10 entries", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  const events = [];
  for (let i = 0; i < 10; i++) {
    const r = await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: `call ${i}` });
    assert.equal(r.ok, true);
    events.push(...(r.shift_events || []).map((e) => e.type));
    now.advance(MIN);
  }
  assert.equal((await shifts(redis, "muse")).length, 1);
  const entries = await allEntries(redis);
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries.map((e) => e.shift)).size, 1, "every write attaches to the one shift");
  assert.deepEqual(events, ["auto-start", ...Array(9).fill("resume")]);
});

test("concurrent stateless calls start one shift, not one each", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  await Promise.all(Array.from({ length: 6 }, (_, i) => sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: `p${i}` })));
  assert.equal((await shifts(redis, "muse")).length, 1);
  assert.equal(new Set((await allEntries(redis)).map((e) => e.shift)).size, 1);
});

test("managed auto Starts pass admission and remain billed lifecycle entries", async () => {
  const redis = createMemoryRedis();
  const now = clock(Date.now());
  const T = "uabcdefghij";
  for (let i = 0; i < 10; i++) {
    const lm = call(redis, now, { space: `t-${T}`, lockedAgent: "muse", limits: createLimits({ redis, tenant: T, plan: "free" }) });
    assert.equal((await sc(lm, "logmem_note", { where: "channel:ops", summary: `billed ${i}` })).ok, true);
  }
  const billed = Number(await redis("GET", `acmi:cloud:meter:${T}:${monthKey(Date.now())}:add`));
  assert.equal(billed, 11, "10 notes and one admitted managed start");
});

test("a different surface is a different shift", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "exec" });
  await sc(call(redis, now, { surface: "telegram" }), "logmem_note", { where: "channel:ops", summary: "tg" });
  await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "exec again" });
  assert.equal((await shifts(redis, "muse")).length, 2);
});

test("no idle Recap for a shift that wrote nothing", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s1", surface: "codex", defaultAgent: "relay", now });
  await sc(lm, "logmem_brief", {}); // a read: auto Start, no entry
  now.advance(31 * MIN);
  const r = await sc(lm, "logmem_brief", {});
  assert.deepEqual(r.shift_events.map((e) => e.type), ["auto-start"], "no auto-recap event");
  assert.equal((await allEntries(redis)).filter((e) => e.kind === "recap").length, 0);
  assert.equal((await shifts(redis, "relay")).length, 2);

  // An explicit Start with nothing after it is also empty: the stdio sweep ends it without a Recap.
  const s = createLogmem({ redis, space: "madez", sessionId: "s2", surface: "stdio", now });
  await sc(s, "logmem_start", { agent: "tally" });
  now.advance(31 * MIN);
  assert.equal(await s.shifts.sweep(), true);
  assert.equal((await allEntries(redis)).filter((e) => e.kind === "recap").length, 0);
  assert.equal(await s.store.getRecap("tally"), null);
});

test("a shift with work still gets its idle Recap, exactly once across sessions", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  const a = call(redis, now);
  await sc(a, "logmem_note", { where: "channel:ops", summary: "real work" });
  now.advance(31 * MIN);
  // A new stateless call finds the open shift gone quiet and recaps it.
  const r = await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "next" });
  assert.deepEqual(r.shift_events.map((e) => e.type), ["auto-recap", "auto-start"]);
  // The first session comes back: it must not recap the same shift again.
  now.advance(MIN);
  const back = await sc(a, "logmem_note", { where: "channel:ops", summary: "back" });
  assert.deepEqual(back.shift_events.map((e) => e.type), ["resume"]);
  assert.equal((await allEntries(redis)).filter((e) => e.kind === "recap").length, 1);
  assert.equal((await shifts(redis, "muse")).length, 2);
});

test("a session idle by its own clock stays on a shift another session kept busy", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  const a = createLogmem({ redis, space: "madez", sessionId: "long-a", surface: "logmem-exec", defaultAgent: "muse", now });
  await sc(a, "logmem_note", { where: "channel:ops", summary: "a1" });
  for (let i = 0; i < 4; i++) {
    now.advance(10 * MIN);
    await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: `b${i}` });
  }
  const r = await sc(a, "logmem_note", { where: "channel:ops", summary: "a2" });
  assert.equal(r.shift_events, undefined, "no recap, no new shift");
  assert.equal((await shifts(redis, "muse")).length, 1);
});

test("a partial read never skips the idle Recap", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s1", surface: "codex", defaultAgent: "relay", now });
  await sc(lm, "logmem_brief", {});
  now.advance(31 * MIN);
  const list = lm.store.list.bind(lm.store);
  lm.store.list = async (ns) => { if (ns === "job") throw new Error("roster down"); return list(ns); };
  await sc(lm, "logmem_brief", {});
  lm.store.list = list;
  const recaps = (await allEntries(redis)).filter((e) => e.kind === "recap");
  assert.equal(recaps.length, 1);
  assert.match(recaps[0].summary, /Partial recap/);
});

test("explicit logmem_start still writes Started and starts a fresh shift", async () => {
  const redis = createMemoryRedis();
  const now = clock();
  await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "auto" });
  const s = createLogmem({ redis, space: "madez", sessionId: "human", surface: "logmem-exec", now });
  const r = await sc(s, "logmem_start", { agent: "muse" });
  assert.equal(r.ok, true);
  assert.equal((await allEntries(redis)).filter((e) => e.kind === "started").length, 1);
  assert.equal((await shifts(redis, "muse")).length, 2);
  // Later stateless calls join the newest shift.
  const next = await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "after" });
  assert.match(r.started.shift, /^museShift-/);
  assert.equal(next.entry.shift, r.started.shift);
});

test("a returning session joins the new shift after its shared shift ended", async () => {
  const redis = createMemoryRedis(), now = clock();
  const a = call(redis, now), b = call(redis, now);
  const first = await sc(a, "logmem_note", { where: "channel:ops", summary: "a first" });
  await sc(b, "logmem_note", { where: "channel:ops", summary: "b joins" });
  await sc(b, "logmem_recap", { notes: "Finished" });
  now.advance(MIN);
  const next = await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "new shift" });
  assert.notEqual(next.entry.shift, first.entry.shift);
  const back = await sc(a, "logmem_note", { where: "channel:ops", summary: "a returns" });
  assert.equal(back.entry.shift, next.entry.shift);
  assert.deepEqual(back.shift_events.map(e => e.type), ["resume"]);
});

test("an old session cannot recap an ended shift after its open slot changes", async () => {
  const redis = createMemoryRedis(), now = clock();
  const a = call(redis, now), b = call(redis, now);
  await sc(a, "logmem_note", { where: "channel:ops", summary: "old" });
  await sc(b, "logmem_note", { where: "channel:ops", summary: "joined" });
  await sc(b, "logmem_recap", { notes: "Finished" });
  now.advance(MIN);
  await sc(call(redis, now), "logmem_note", { where: "channel:ops", summary: "new" });
  now.advance(31 * MIN);
  assert.equal(await a.shifts.sweep(), false);
  assert.equal((await allEntries(redis)).filter(e => e.kind === "recap").length, 1);
});


test("ended state survives removal of the shared open slot", async () => {
  const redis = createMemoryRedis(), now = clock();
  const a = call(redis, now), b = call(redis, now);
  const first = await sc(a, "logmem_note", { where: "channel:ops", summary: "old" });
  await sc(b, "logmem_note", { where: "channel:ops", summary: "joined" });
  await sc(b, "logmem_recap", { notes: "Finished" });
  await redis("DEL", "lm:madez:session:open-shift-muse-logmem-exec");
  const back = await sc(a, "logmem_note", { where: "channel:ops", summary: "returned" });
  assert.notEqual(back.entry.shift, first.entry.shift);
  assert.equal((await allEntries(redis)).filter(e => e.kind === "recap").length, 1);
});
