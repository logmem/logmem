import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  todayCounts, needsRows, blockedReason, blockedRows, recentRows, coverageNotice,
} from "../apps/dashboard/lib/today-model.mjs";

const NOW = 1_800_000_000_000;
const view = (o = {}) => ({
  plans: [{ id: "launch", jobs: 10, done: 4 }, { id: "general", jobs: 3, done: 1 }],
  blocked: [
    { id: "j1", title: "Checkout", owner: "agent:hermes", blocked_on: { type: "task", ref: "handoffX", note: "Square app is missing." }, since: NOW - 1000 },
    { id: "j2", blocked_on: null },
  ],
  needs_items: [
    { type: "decision", trail: "ask1", job: "j1", summary: "Create the project?", by: "agent:claude-code", created_at: NOW - 5000 },
    { type: "task", trail: "t1", job: "j2", summary: "Unlock billing", by: "agent:infra", steps: 4, steps_done: 1 },
    { type: "suggestion", trail: "suggest:j3", job: "j3", summary: "Old job", owner: "agent:muse", created_at: 0 },
  ],
  recent: [{ ts: NOW - 60_000, kind: "progress", by: "agent:codex", summary: "Fixed it.", trail: "tr", where: "job:j1" }],
  coverage: { complete: false, errors: [] },
  ...o,
});

test("today model: counts come from the view, not from constants", () => {
  assert.deepEqual(todayCounts(view()), { decisions: 1, tasks: 1, waiting: 2, done: 5, jobs: 13 });
  assert.deepEqual(todayCounts({}), { decisions: 0, tasks: 0, waiting: 0, done: 0, jobs: 0 });
  assert.deepEqual(todayCounts(null), { decisions: 0, tasks: 0, waiting: 0, done: 0, jobs: 0 });
});

test("today model: needs rows keep order and label each kind", () => {
  const rows = needsRows(view());
  assert.deepEqual(rows.map((r) => r.label), ["Decision", "Task", "Looks done?"]);
  assert.equal(rows[1].progress, "1/4");
  assert.equal(rows[0].progress, null);
  assert.equal(rows[2].by, "agent:muse");
  assert.equal(rows[2].createdAt, null, "a zero timestamp is not shown as a time");
  assert.equal(needsRows({ needs_items: [{ type: "task" }] })[0].summary, "No summary recorded.");
});

test("today model: a blocked reason is read, never guessed", () => {
  assert.equal(blockedReason({ type: "task", note: "Square app is missing." }), "Square app is missing.");
  assert.equal(blockedReason({ type: "decision", ref: "ask1" }), "Waits on decision ask1.");
  assert.equal(blockedReason({ ref: "agent:codex" }), "Waits on agent:codex.");
  assert.equal(blockedReason("  "), "No reason recorded.");
  assert.equal(blockedReason(null), "No reason recorded.");
  const rows = blockedRows(view());
  assert.equal(rows[1].title, "j2");
  assert.equal(rows[1].reason, "No reason recorded.");
  assert.equal(blockedRows(view(), 1).length, 1);
});

test("today model: recent rows and the coverage notice", () => {
  assert.equal(recentRows(view())[0].summary, "Fixed it.");
  assert.equal(recentRows({}).length, 0);
  assert.equal(coverageNotice(view()), null);
  assert.equal(coverageNotice(view({ coverage: { errors: [{}] } })), "1 record could not be read. Counts can be low.");
  assert.equal(coverageNotice(view({ coverage: { errors: [{}, {}] } })), "2 records could not be read. Counts can be low.");
});

test("today screen reads the home view and has no fixed sample rows", () => {
  const page = readFileSync("apps/dashboard/app/(workspace)/space/[space]/today/page.tsx", "utf8");
  const loader = readFileSync("apps/dashboard/lib/server/today.ts", "utf8");
  assert.match(page, /getTodayData\(/);
  assert.match(page, /requireSpace\(/);
  assert.match(loader, /buildView\([^)]*'home'/);
  assert.match(loader, /unavailable: true/);
  for (const word of ["QA pass", "sample", "407b953", "mock"]) {
    assert.equal(page.includes(word), false, `today page contains ${word}`);
  }
});
