// The dogfood pause (Mikey, 2026-10-17): while LogMem is parked under One Lane,
// the check still runs, but paused days do not count and do not break the streak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { gate, runDaily, pauseKey, readPause, DAY_MS } from "../scripts/dogfood-check.mjs";

const day = (date, pass, extra = {}) => ({ date, pass, ...extra });

test("pause: paused days are skipped, and a run of passing days around them stays consecutive", () => {
  const days = [
    day("2026-10-10", true), day("2026-10-11", true), day("2026-10-12", true),
    day("2026-10-13", false, { paused: true }), day("2026-10-14", false, { paused: true }),
    day("2026-10-15", true), day("2026-10-16", true), day("2026-10-17", true), day("2026-10-18", true),
  ];
  const g = gate({ days, deliverable: { stage: "done" } });
  assert.equal(g.days_passing, 7);
  assert.equal(g.consecutive, true);
  assert.equal(g.pass, true);
  assert.equal(g.paused_days, 2);
});

test("pause: a real gap (a missing date that is not paused) still breaks the streak", () => {
  const days = ["10", "11", "12", "14", "15", "16", "17"].map((d) => day(`2026-10-${d}`, true));
  assert.equal(gate({ days, deliverable: { stage: "done" } }).consecutive, false);
});

test("pause: unpaused behaviour is unchanged", () => {
  const days = ["11", "12", "13", "14", "15", "16", "17"].map((d) => day(`2026-10-${d}`, true));
  const g = gate({ days, deliverable: { stage: "done" } });
  assert.deepEqual(g, { days_passing: 7, consecutive: true, deliverable_done: true, pass: true }, "same shape as before the pause existed");
});

test("pause: runDaily marks today and earlier days since the pause as paused, and writes no stuck entry", async () => {
  const redis = createMemoryRedis();
  const T0 = Date.parse("2026-10-17T13:00:00Z");
  // A handoff sent 3 days ago and never accepted: unpaused, this writes a stuck entry.
  await redis("ZADD", "lm:fieldnotes:channel:ops:log", String(T0 - 3 * DAY_MS), JSON.stringify({ ts: T0 - 3 * DAY_MS, kind: "handoff", by: "agent:quill", to: "agent:atlas", trail: "h1", summary: "x", job: "channel:ops" }));
  await redis("SET", "lm:fieldnotes:dogfood:scorecard", JSON.stringify({ space: "fieldnotes", days: [day("2026-10-15", true), day("2026-10-16", false)] }));
  await redis("SET", pauseKey("fieldnotes"), JSON.stringify({ since: "2026-10-16", reason: "LogMem parked under One Lane", by: "human:mikey" }));

  const r = await runDaily(redis, { space: "fieldnotes", mirrorSpaces: [], now: T0 });
  const byDate = Object.fromEntries(r.card.days.map((d) => [d.date, d]));
  assert.equal(byDate["2026-10-15"].paused, undefined, "before the pause: untouched");
  assert.equal(byDate["2026-10-16"].paused, true, "backdated");
  assert.equal(byDate["2026-10-17"].paused, true, "today");
  assert.equal(r.card.pause.since, "2026-10-16");
  assert.equal(r.res.day.stuck_written, 0, "no stuck alerts while paused");
  const log = (await redis("ZRANGE", "lm:fieldnotes:channel:ops:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(!log.some((e) => e.kind === "stuck"));
});

test("pause: readPause ignores junk and a missing key", async () => {
  const redis = createMemoryRedis();
  assert.equal(await readPause(redis, "fieldnotes"), null);
  await redis("SET", pauseKey("fieldnotes"), "not json");
  assert.equal(await readPause(redis, "fieldnotes"), null);
  await redis("SET", pauseKey("fieldnotes"), JSON.stringify({ since: "16 Oct" }));
  assert.equal(await readPause(redis, "fieldnotes"), null, "since must be YYYY-MM-DD");
});

// Review fixes (codex on review-pr54, plus claude-code), Oct 18.
import { createLogmem } from "../src/server.mjs";
import { runCheck, updateScorecard, isCalendarDate, MAX_ROWS } from "../scripts/dogfood-check.mjs";
import { buildScorecard } from "../api/scorecard.mjs";

const ON = { enabled: true, spaces: ["madez"] };
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
async function team(redis, space = "madez") {
  const mk = (sid, surface) => createLogmem({ redis, space, sessionId: sid, surface, mirror: ON, compat: true });
  const a = mk("a", "claude-code"), b = mk("b", "grok-local"), c = mk("c", "claude-code");
  await sc(a, "logmem_start", { agent: "claude-code" });
  await sc(b, "logmem_start", { agent: "grok-local" });
  await sc(c, "logmem_start", { agent: "claude-engineer" });
  return { a, b, c };
}

test("pause: impossible calendar dates are refused", async () => {
  for (const bad of ["2026-99-99", "2026-02-30", "2026-13-01", "2026-10-1", 20261016, null]) assert.equal(isCalendarDate(bad), false, String(bad));
  assert.equal(isCalendarDate("2026-10-16"), true);
  const redis = createMemoryRedis();
  await redis("SET", pauseKey("fieldnotes"), JSON.stringify({ since: "2026-99-99" }));
  assert.equal(await readPause(redis, "fieldnotes"), null, "a bad date must not turn off stuck alerts");
});

test("pause: a long pause keeps the counted days and the streak", () => {
  let card = { days: [] };
  const add = (date, pass, paused) => {
    card = updateScorecard(card, { day: { date, pass, space: "x", mismatch_examples: [] }, deliverable: { stage: "done" } });
    if (paused) card.days.find((d) => d.date === date).paused = true;
  };
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const start = Date.parse("2026-09-01");
  for (let i = 0; i < 6; i++) add(iso(start + i * DAY_MS), true, false);
  for (let i = 6; i < 46; i++) add(iso(start + i * DAY_MS), false, true); // 40 paused days
  add(iso(start + 46 * DAY_MS), true, false); // resume
  assert.equal(card.days.filter((d) => !d.paused).length, 7, "no counted day pushed out");
  assert.equal(card.days.filter((d) => d.paused).length, 40);
  const g = gate(card);
  assert.equal(g.consecutive, true);
  assert.equal(g.pass, true);
  assert.ok(card.days.length <= MAX_ROWS);
});

test("pause: the scorecard API keeps paused days paused, with or without the key", async () => {
  const redis = createMemoryRedis();
  await team(redis);
  const T0 = Date.parse("2026-10-17T13:00:00Z");
  await redis("SET", pauseKey("madez"), JSON.stringify({ since: "2026-10-17", reason: "parked", by: "human:mikey" }));
  await runDaily(redis, { space: "madez", now: T0 });
  let card = await buildScorecard(redis, "madez");
  assert.equal(card.days.find((d) => d.date === "2026-10-17").paused, true);
  assert.equal(card.pause.since, "2026-10-17");
  assert.equal(card.gate.paused_days, 1);
  await redis("DEL", pauseKey("madez")); // resumed: past paused days stay paused
  card = await buildScorecard(redis, "madez");
  assert.equal(card.days.find((d) => d.date === "2026-10-17").paused, true);
});

test("ack lookup: an ACMI ack on the thread counts even when the handoff is also in the agent log", async () => {
  const redis = createMemoryRedis();
  const { a } = await team(redis);
  const ho = await sc(a, "logmem_handoff", { to: "bentley-main", where: "channel:agent-coordination", summary: "drafts", create_agent: true });
  const ack = { ts: Date.now(), source: "agent:bentley-main", kind: "handoff-ack", correlationId: "b1", parentCorrelationId: ho.trail, summary: "ack" };
  await redis("ZADD", "acmi:madez:thread:agent-coordination:timeline", ack.ts, JSON.stringify(ack));
  const { day } = await runCheck(redis, { space: "madez" });
  assert.equal(day.handoffs, 1);
  assert.equal(day.accepted, 1, "found on the thread, whichever log the handoff was seen in first");
});

test("ack lookup: a decline answers the handoff (LogMem and ACMI)", async () => {
  const redis = createMemoryRedis();
  const { a, b } = await team(redis);
  const ho = await sc(a, "logmem_handoff", { to: "grok-local", where: "job:logmem-v0-ship", summary: "research" });
  await sc(b, "logmem_accept", { trail: ho.trail, decline: true, reason: "parked under One Lane" });
  let r = await runCheck(redis, { space: "madez", now: Date.now() + DAY_MS + 60_000 });
  assert.equal(r.day.unanswered_24h, 0, "a LogMem decline is an answer");

  const redis2 = createMemoryRedis();
  const t2 = await team(redis2);
  const ho2 = await sc(t2.a, "logmem_handoff", { to: "grok", summary: "research", create_agent: true });
  const decl = { ts: Date.now(), source: "agent:grok", kind: "review-note", correlationId: "d1", parentCorrelationId: ho2.trail, summary: "Declined: parked", payload: { declined: true } };
  await redis2("ZADD", "acmi:madez:agent:grok:timeline", decl.ts, JSON.stringify(decl));
  r = await runCheck(redis2, { space: "madez", now: Date.now() + DAY_MS + 60_000 });
  assert.equal(r.day.unanswered_24h, 0, "an ACMI decline is an answer");
});
