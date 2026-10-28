import test from "node:test";
import assert from "node:assert/strict";
import { splitHeadline, attentionKind, attentionCounts, filterAttention, splitPlans } from "../public/app/dashboard-model.js";

test("Today: short titles stay whole", () => {
  assert.deepEqual(splitHeadline("Brand email and X handle"), { head: "Brand email and X handle", body: "" });
  assert.deepEqual(splitHeadline(""), { head: "", body: "" });
  assert.deepEqual(splitHeadline(null), { head: "", body: "" });
});

test("Today: a long title splits at the first colon or sentence end", () => {
  const long = "Provider billing snapshots needed: export 30 days of usage from each provider and attach it to the job so the cost model can be checked.";
  const r = splitHeadline(long);
  assert.equal(r.head, "Provider billing snapshots needed");
  assert.match(r.body, /^export 30 days/);
  const s = splitHeadline("Dashboard side closure for bypass B2. Move the deploy to a production environment secret and name one release owner for every release.");
  assert.equal(s.head, "Dashboard side closure for bypass B2");
});

test("Today: a long title with no split point is cut at a word boundary", () => {
  const r = splitHeadline("word ".repeat(40).trim());
  assert.ok(r.head.endsWith("…") && r.head.length <= 90);
  assert.ok(r.body.length > 0);
});

test("Today: filter and counts by request type", () => {
  const items = [{ type: "decision" }, { type: "decision" }, { type: "task" }, { type: "review" }, { type: "other" }];
  assert.equal(attentionKind({ type: "task" }), "task");
  assert.equal(attentionKind({ type: "x" }), "review");
  assert.deepEqual(attentionCounts(items), { all: 5, decision: 2, task: 1, review: 2 });
  assert.equal(filterAttention(items, "decision").length, 2);
  assert.equal(filterAttention(items, "all").length, 5);
  assert.deepEqual(attentionCounts(), { all: 0, decision: 0, task: 0, review: 0 });
});

test("Today: plans with no work go behind the parked toggle", () => {
  const plans = [{ id: "launch", jobs: 40 }, { id: "entry", jobs: 0 }, { id: "general", jobs: 0 }, { id: "metering", jobs: "0" }, { id: "paused", jobs: 10, lane: {status: "parked"} }];
  const r = splitPlans(plans);
  assert.deepEqual(r.active.map(p => p.id), ["launch"]);
  assert.deepEqual(r.empty.map(p => p.id), ["entry", "general", "metering", "paused"]);
});
