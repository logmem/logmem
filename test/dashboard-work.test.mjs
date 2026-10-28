import test from "node:test";
import assert from "node:assert/strict";
import { fmtDue, dueState, workMatch, workCounts, WORK_MODES, trackKey, trackLabels, blockerNote, sharedBlockers } from "../public/app/dashboard-model.js";

const late = (j) => j.due && j.due < "2026-10-27";

test("Work: the due label shows the date once", () => {
  assert.equal(fmtDue("2026-11-10"), "Nov 10");
  assert.equal(fmtDue("2026-10-23T09:00:00Z"), "Oct 23");
  assert.deepEqual(dueState({ due: "2026-11-10", stage: "open" }, late), { kind: "due", text: "Due Nov 10" });
  assert.deepEqual(dueState({ due: "2026-10-23", stage: "active" }, late), { kind: "late", text: "Overdue · Oct 23" });
  assert.deepEqual(dueState({ due: "2026-10-23", stage: "done" }, late), { kind: "due", text: "Due Oct 23" });
  assert.deepEqual(dueState({}, late), { kind: "none", text: "—" });
  for (const j of [{ due: "2026-11-10" }, { due: "2026-10-23" }]) assert.doesNotMatch(dueState(j, late).text, /(\d{4}|\w{3} \d+).*\1/);
});

const jobs = [
  { id: "a", stage: "active" }, { id: "b", stage: "open" }, { id: "c", stage: "done" },
  { id: "d", stage: "blocked", blocked_on: { note: "Waits for Mikey to grant the repo." } },
  { id: "e", stage: "blocked", blocked_on: { note: "Waits for Mikey to grant the repo." } },
  { id: "f", stage: "blocked", blocked_on: { note: "other", parked: true } },
  { id: "g", stage: "open", due: "2026-10-20" },
];

test("Work: status modes and counts", () => {
  const ids = (m) => jobs.filter((j) => workMatch(j, m, late)).map((j) => j.id);
  assert.deepEqual(ids("live"), ["a", "d", "e"]);
  assert.deepEqual(ids("blocked"), ["d", "e"]);
  assert.deepEqual(ids("parked"), ["f"]);
  assert.deepEqual(ids("open"), ["b", "g"]);
  assert.deepEqual(ids("late"), ["g"]);
  assert.deepEqual(ids("done"), ["c"]);
  assert.equal(ids("all").length, 7);
  const c = workCounts(jobs, late);
  assert.deepEqual(Object.keys(c), WORK_MODES.map(([k]) => k));
  assert.equal(c.live, 3);
});

test("Work: track options ignore case and spacing", () => {
  assert.equal(trackKey(" App  Store "), "app store");
  assert.deepEqual(trackLabels(["app", "App", "content", "Content", " ops ", "Ops", "", null, "Distribution", "distribution"]), ["App", "Content", "Distribution", "Ops"]);
});

test("Work: shared blockers need two or more blocked, unparked jobs", () => {
  assert.equal(blockerNote(jobs[5]), "");
  assert.equal(blockerNote(jobs[0]), "");
  const shared = sharedBlockers(jobs);
  assert.equal(shared.size, 1);
  assert.equal(shared.get("Waits for Mikey to grant the repo."), 2);
});
