import test from "node:test";
import assert from "node:assert/strict";
import { timeBucket, groupDecisions, verdictLabel, agentColor, decisionGraph, BUCKETS } from "../public/app/dashboard-model.js";

const NOW = new Date(2026, 9, 27, 15, 0, 0).getTime();
const at = (daysAgo, h = 9) => new Date(2026, 9, 27 - daysAgo, h, 0, 0).getTime();

test("Knowledge: time buckets use local days", () => {
  assert.equal(timeBucket(at(0, 1), NOW), "Today");
  assert.equal(timeBucket(at(1, 23), NOW), "Yesterday");
  assert.equal(timeBucket(at(3), NOW), "Earlier this week");
  assert.equal(timeBucket(at(9), NOW), "Earlier");
  assert.equal(timeBucket(undefined, NOW), "Earlier");
});

test("Knowledge: decisions group in order and empty groups are dropped", () => {
  const items = [{ answer: { ts: at(9) } }, { answer: { ts: at(0) } }, { answer: { ts: at(0, 2) } }, { answer: { ts: at(1) } }];
  const g = groupDecisions(items, NOW);
  assert.deepEqual(g.map((x) => [x.label, x.items.length]), [["Today", 2], ["Yesterday", 1], ["Earlier", 1]]);
  assert.deepEqual(BUCKETS, ["Today", "Yesterday", "Earlier this week", "Earlier"]);
});

test("Knowledge: verdict labels and stable agent colours", () => {
  assert.equal(verdictLabel("approve"), "Approved"); assert.equal(verdictLabel("reject"), "Changes requested");
  assert.equal(verdictLabel("defer"), "Deferred"); assert.equal(verdictLabel(null), null);
  assert.equal(agentColor("agent:muse"), agentColor("agent:muse"));
  assert.match(agentColor("agent:muse"), /^#[0-9a-f]{6}$/);
});

test("Knowledge: the graph has one row per asker, busiest first", () => {
  const waiting = [{ by: "agent:muse", trail: "w1", summary: "a" }, { by: "agent:muse", trail: "w2", summary: "b" }, { by: "agent:codex", trail: "w3", summary: "c" }];
  const decided = [{ ask: { by: "agent:codex", trail: "d1", summary: "d" } }, { ask: { by: "agent:grok", trail: "d2", summary: "e" } }, { ask: { by: "agent:grok", trail: "d3", summary: "f" } }, { ask: { by: "agent:grok", trail: "d4", summary: "g" } }];
  const rows = decisionGraph(waiting, decided);
  assert.deepEqual(rows.map((r) => r.agent), ["agent:muse", "agent:codex", "agent:grok"]);
  assert.deepEqual(rows[0].nodes.map((n) => n.state), ["pending", "pending"]);
  assert.equal(decisionGraph(waiting, decided, { rows: 1 }).length, 1);
  assert.equal(decisionGraph(waiting, decided, { perRow: 1 })[2].nodes.length, 1);
  assert.deepEqual(decisionGraph(), []);
});
