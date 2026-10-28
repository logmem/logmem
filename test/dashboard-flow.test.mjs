import test from "node:test";
import assert from "node:assert/strict";
import { ageBand, ageLabel, handoffArcs, arcAgents, ringPoints, arcPath, replayEntries, replayBounds, replayAt, atFraction, pulseLanes, pulseAxis, blockerClusters, unblockPrompt, bubbleLayout } from "../public/app/flow-model.js";

const NOW = Date.parse("2026-10-28T12:00:00Z"), H = 3600000, D = 86400000;

test("Handoff map: arcs carry age bands and drop bad rows", () => {
  const arcs = handoffArcs([
    { trail: "a", from: "agent:claude-code", to: "agent:antigravity", created_at: NOW - 13 * D, summary: "Old" },
    { trail: "b", from: "agent:muse", to: "agent:hermes", created_at: NOW - 30 * H, summary: "New" },
    { trail: "c", from: "agent:muse", to: "agent:muse", created_at: NOW - H },
    { trail: "d", from: "agent:muse", to: "agent:codex", created_at: NOW + D },
    { trail: "e", from: "", to: "agent:codex", created_at: NOW - H },
    { trail: "f", from: "agent:codex", to: "agent:muse", created_at: "bad" },
  ], NOW);
  assert.deepEqual(arcs.map(a => a.trail), ["a", "b"]);
  assert.equal(arcs[0].band, "stale");
  assert.equal(arcs[0].label, "13 d");
  assert.equal(arcs[1].band, "fresh");
  assert.equal(arcs[1].label, "1 d");
  assert.deepEqual(arcAgents(arcs), ["antigravity", "claude-code", "hermes", "muse"]);
  assert.equal(ageBand(5), "slow");
  assert.equal(ageLabel(90 * 60000), "2 h");
  assert.equal(ageLabel(10 * 60000), "1 h");
});

test("Handoff map: ring and curve geometry", () => {
  const pts = ringPoints(4, 100, 100, 50);
  assert.deepEqual(pts[0], { x: 100, y: 50 });
  assert.deepEqual(pts[1], { x: 150, y: 100 });
  assert.equal(ringPoints(0, 0, 0, 1).length, 0);
  assert.match(arcPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 100), /^M0 0 Q50 35 100 0$/);
});

test("Time scrubber: replay keeps real timestamps and counts by kind", () => {
  const rows = replayEntries([
    { ts: NOW - 3 * H, kind: "handoff" }, { ts: NOW - 2 * H, kind: "stuck" }, { ts: "x", kind: "done" },
    { ts: NOW + H, kind: "done" }, { ts: NOW - H, kind: "done" }, { ts: NOW - 4 * H, kind: "progress" },
  ], NOW);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].kind, "progress");
  const b = replayBounds(rows);
  assert.deepEqual(b, { start: NOW - 4 * H, end: NOW - H });
  assert.equal(replayBounds([]), null);
  const mid = replayAt(rows, NOW - 2 * H);
  assert.equal(mid.total, 3);
  assert.deepEqual(mid.counts, { handoff: 1, approval: 0, stuck: 1, done: 0, progress: 1 });
  assert.equal(mid.last[0].kind, "stuck");
  assert.equal(replayAt(rows, b.end).total, 4);
  assert.equal(replayAt(rows, b.start - 1).total, 0);
  assert.equal(atFraction(b, 0), b.start);
  assert.equal(atFraction(b, 2), b.end);
});

test("Fleet pulse: runs, recaps, long quiet and sorting", () => {
  const e = (by, ago, kind = "progress") => ({ by: "agent:" + by, ts: NOW - ago * 60000, kind });
  const lanes = pulseLanes([
    e("muse", 600), e("muse", 590), e("muse", 20), e("muse", 5, "recap"),
    e("codex", 700), e("old", 99999), { by: "agent:muse", ts: NOW + H }, { by: "", ts: NOW - 5 },
  ], 24, NOW, ["idle"]);
  assert.deepEqual(lanes.map(l => l.id), ["muse", "codex", "idle"]);
  const muse = lanes[0];
  assert.equal(muse.live, true);
  assert.equal(muse.bars.length, 2);
  assert.equal(muse.recaps.length, 1);
  assert.equal(muse.state, "Wrote just now");
  assert.equal(muse.quiet.length, 2);
  assert.equal(muse.quiet[0].hours, 14);
  assert.equal(lanes[1].state, "Quiet 12 h");
  assert.equal(lanes[2].empty, true);
  assert.equal(lanes[2].state, "No entries in this window");
  assert.deepEqual(pulseAxis(24), ["24 h ago", "18 h ago", "12 h ago", "6 h ago", "now"]);
});

test("Blocker map: same text becomes one bubble, parked jobs are left out", () => {
  const jobs = [
    { id: "a", stage: "blocked", blocked_on: { note: "Waits for a repo grant." } },
    { id: "b", stage: "blocked", blocked_on: { note: "waits for a repo grant." } },
    { id: "c", stage: "blocked", blocked_on: { note: "Needs a ruling.", type: "decision" } },
    { id: "d", stage: "blocked", blocked_on: { note: "Parked thing.", parked: true } },
    { id: "e", stage: "active" },
  ];
  const cl = blockerClusters(jobs);
  assert.equal(cl.length, 2);
  assert.equal(cl[0].jobs.length, 2);
  assert.equal(cl[0].who, "agent");
  assert.equal(cl[1].who, "person");
  assert.ok(cl[0].radius > cl[1].radius);
  const p = unblockPrompt(cl[0], "fieldnotes");
  assert.match(p, /space: fieldnotes/);
  assert.match(p, /\(2 jobs\): a, b/);
  assert.doesNotMatch(unblockPrompt({ note: "x", jobs: [{ id: "z" }] }, null), /jobs\)/);
  const lay = bubbleLayout(cl, 600, 470);
  assert.equal(lay.length, 2);
  assert.notDeepEqual([lay[0].x, lay[0].y], [lay[1].x, lay[1].y]);
  assert.deepEqual(bubbleLayout([], 600, 470), []);
});
