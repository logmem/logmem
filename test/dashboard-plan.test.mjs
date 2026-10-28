import test from "node:test";
import assert from "node:assert/strict";
import { planMatch, planCounts, mergeTracks, PLAN_MODES } from "../public/app/dashboard-model.js";

const jobs = [
  { id: "a", stage: "done" }, { id: "b", stage: "active" }, { id: "c", stage: "open" },
  { id: "d", stage: "blocked", blocked_on: { type: "decision" } },
  { id: "e", stage: "blocked", blocked_on: { type: "task" } },
  { id: "f", stage: "blocked", blocked_on: { type: "job" } },
  { id: "g", stage: "active", late: true },
];
const late = (j) => j.late === true;

test("Plan: filter modes match the right jobs", () => {
  const ids = (m) => jobs.filter((j) => planMatch(j, m, late)).map((j) => j.id);
  assert.deepEqual(ids("all"), ["a", "b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(ids("open"), ["b", "c", "g"]);
  assert.deepEqual(ids("blocked"), ["d", "e", "f"]);
  assert.deepEqual(ids("waiting"), ["d", "e"]);
  assert.deepEqual(ids("late"), ["g"]);
  assert.deepEqual(ids("done"), ["a"]);
});

test("Plan: counts cover every mode", () => {
  const c = planCounts(jobs, late);
  assert.deepEqual(Object.keys(c), PLAN_MODES.map(([k]) => k));
  assert.equal(c.all, 7); assert.equal(c.waiting, 2); assert.equal(c.done, 1);
});

test("Plan: workstreams that differ only by case merge, others stay apart", () => {
  const merged = mergeTracks([
    { title: "Distribution", percent: 7, items: [{ id: "1", stage: "done" }, { id: "2", stage: "open" }] },
    { title: "distribution", percent: 15, items: [{ id: "3", stage: "done" }] },
    { title: " App ", items: [{ id: "4", stage: "open" }] },
    { title: "app", items: [] },
    { title: "content", items: [{ id: "5", stage: "done" }] },
    { title: "Content + marketing", items: [{ id: "6", stage: "done" }] },
  ]);
  assert.deepEqual(merged.map((t) => t.title), ["Distribution", "App", "Content", "Content + marketing"]);
  assert.equal(merged[0].items.length, 3); assert.equal(merged[0].done, 2); assert.equal(merged[0].percent, 67);
  assert.equal(merged[2].percent, 100);
});

test("Plan: a single workstream keeps its own percent", () => {
  const [t] = mergeTracks([{ title: "Solo", percent: 43, items: [{ id: "x", stage: "open" }] }]);
  assert.equal(t.percent, 43);
});
