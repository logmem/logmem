import test from "node:test";
import assert from "node:assert/strict";
import { needsTabs, filterNeedsTab, normalizeNeedsTab } from "../public/app/dashboard-model.js";

const items = [
  { type: "decision", trail: "d1" },
  { type: "decision", trail: "d2" },
  { type: "task", trail: "t1" },
  { type: "suggestion", trail: "suggest:j1" },
  { type: "mystery", trail: "m1" },
];

test("Needs you: the tab counts other than All add up to All", () => {
  const tabs = needsTabs(items);
  const all = tabs.find(([id]) => id === "all")[2];
  assert.equal(all, items.length);
  const rest = tabs.filter(([id]) => id !== "all").reduce((sum, [, , n]) => sum + n, 0);
  assert.equal(rest, all);
});

test("Needs you: Looks done and Other tabs appear only when they have items", () => {
  assert.deepEqual(needsTabs([{ type: "task", trail: "t" }]).map(([id]) => id), ["all", "decision", "task"]);
  assert.deepEqual(needsTabs(items).map(([id, , n]) => [id, n]), [["all", 5], ["decision", 2], ["task", 1], ["suggestion", 1], ["other", 1]]);
});

test("Needs you: each tab filter returns only its own items", () => {
  assert.equal(filterNeedsTab(items, "all").length, 5);
  assert.deepEqual(filterNeedsTab(items, "decision").map((i) => i.trail), ["d1", "d2"]);
  assert.deepEqual(filterNeedsTab(items, "suggestion").map((i) => i.trail), ["suggest:j1"]);
  assert.deepEqual(filterNeedsTab(items, "other").map((i) => i.trail), ["m1"]);
});

test("Needs you: old drawer ids map to the item kinds", () => {
  assert.equal(normalizeNeedsTab("decisions"), "decision");
  assert.equal(normalizeNeedsTab("tasks"), "task");
  assert.equal(normalizeNeedsTab("all"), "all");
  assert.equal(normalizeNeedsTab(undefined), "all");
});
