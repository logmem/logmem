import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { runCheck, updateScorecard, gate, DAY_MS } from "../scripts/dogfood-check.mjs";

const ON = { enabled: true, spaces: ["madez"] };
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;

async function team(redis, space, mirror = ON) {
  const mk = (sid, surface) => createLogmem({ redis, space, sessionId: sid, surface, mirror, compat: true });
  const a = mk("a", "claude-code"), b = mk("b", "grok-local"), c = mk("c", "claude-code");
  await sc(a, "logmem_start", { agent: "claude-code" });
  await sc(b, "logmem_start", { agent: "grok-local" });
  await sc(c, "logmem_start", { agent: "claude-engineer" });
  return { a, b, c };
}

test("healthy day passes: parity 0, 3 agents, handoff accepted", async () => {
  const redis = createMemoryRedis();
  const { a, b } = await team(redis, "madez");
  const ho = await sc(a, "logmem_handoff", { to: "grok-local", where: "job:logmem-v0-ship", summary: "review #1" });
  await sc(b, "logmem_note", { where: "job:logmem-v0-ship", kind: "accepted", summary: "on it", origin: ho.trail });
  const { day } = await runCheck(redis, { space: "madez" });
  assert.equal(day.mirror_mismatches, 0);
  assert.deepEqual(day.agents, ["agent:claude-code", "agent:claude-engineer", "agent:grok-local"]);
  assert.equal(day.handoffs, 1);
  assert.equal(day.accepted, 1);
  assert.equal(day.pass, true);
  const log = await redis("ZRANGE", "lm:madez:job:logmem-dogfood:log", 0, -1);
  assert.equal(JSON.parse(log[0]).kind, "checkup");
  assert.equal(await redis("ZCARD", "acmi:madez:work:logmem-dogfood:timeline"), 1, "checkup mirrored to ACMI");
});

test("missing ACMI twin = mismatch = fail", async () => {
  const redis = createMemoryRedis();
  await team(redis, "madez");
  await redis("DEL", "acmi:madez:agent:claude-code:timeline");
  const { day } = await runCheck(redis, { space: "madez" });
  assert.ok(day.mirror_mismatches >= 1);
  assert.equal(day.health_pass, false);
  assert.equal(day.pass, false);
});

test("ACMI-side handoff-ack counts as accepted (VM agents)", async () => {
  const redis = createMemoryRedis();
  const { a } = await team(redis, "madez");
  const ho = await sc(a, "logmem_handoff", { to: "bentley", summary: "check prod", create_agent: true });
  const ack = { ts: Date.now(), source: "agent:bentley", kind: "handoff-ack", correlationId: "b1", parentCorrelationId: ho.trail, summary: "ack" };
  await redis("ZADD", "acmi:madez:agent:bentley:timeline", ack.ts, JSON.stringify(ack));
  const { day } = await runCheck(redis, { space: "madez" });
  assert.equal(day.accepted, day.handoffs);
});

test("unanswered handoff > 24h writes one stuck entry (mirrored), not twice", async () => {
  const redis = createMemoryRedis();
  const { a } = await team(redis, "madez");
  const ho = await sc(a, "logmem_handoff", { to: "bentley", summary: "old ask", create_agent: true });
  const later = Date.now() + DAY_MS + 60_000;
  const r1 = await runCheck(redis, { space: "madez", now: later });
  assert.equal(r1.day.unanswered_24h, 1);
  assert.equal(r1.day.stuck_written, 1);
  assert.equal(r1.day.pass, false);
  const r2 = await runCheck(redis, { space: "madez", now: later + 1000 });
  assert.equal(r2.day.stuck_written, 0, "no duplicate stuck");
  const acmi = (await redis("ZRANGE", "acmi:madez:agent:bentley:timeline", 0, -1)).map(JSON.parse);
  assert.ok(acmi.some((e) => e.kind === "stalled-alert" && e.parentCorrelationId === ho.trail), "ACMI sweep can see it");
});

test("self-reported degraded session fails the day", async () => {
  const redis = createMemoryRedis();
  const { a } = await team(redis, "madez");
  await sc(a, "logmem_note", { where: "agent:claude-code", kind: "problem", summary: "was degraded 10:00-10:20", payload: { degraded: true } });
  const { day } = await runCheck(redis, { space: "madez" });
  assert.equal(day.degraded_sessions, 1);
  assert.equal(day.pass, false);
});

test("sandbox space: no parity check, scorecard upsert + 7-day gate", async () => {
  const redis = createMemoryRedis();
  await team(redis, "fieldnotes", { enabled: false, spaces: [] });
  const res = await runCheck(redis, { space: "fieldnotes" });
  assert.equal(res.day.mirror_checked, false);
  let card = null;
  const base = Date.parse("2026-10-13T13:00:00Z");
  for (let i = 0; i < 7; i++) card = updateScorecard(card, { day: { ...res.day, date: new Date(base + i * DAY_MS).toISOString().slice(0, 10), pass: true }, deliverable: { stage: "active" } });
  card = updateScorecard(card, { day: { ...res.day, date: "2026-10-19", pass: true }, deliverable: { stage: "done" } });
  assert.equal(card.days.length, 7, "same date upserts");
  assert.deepEqual(gate(card), { days_passing: 7, consecutive: true, deliverable_done: true, pass: true });
  card.days[3].pass = false;
  assert.equal(gate(card).pass, false);
});
