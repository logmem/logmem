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
