import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJobs, stageCounts, filterJobsByStage } from "../apps/dashboard/lib/work-model.mjs";
import { normalizeAgents, agentCounts } from "../apps/dashboard/lib/agents-model.mjs";
import { normalizeEntries, groupCounts, filterEntriesByGroup, entryKindGroup } from "../apps/dashboard/lib/activity-model.mjs";
import { buildSchedule } from "../apps/dashboard/lib/schedule-model.mjs";
import { buildAccessFlags, buildConnectSnippets } from "../apps/dashboard/lib/access-model.mjs";

test("work-model: normalizes jobs, excludes milestones, counts and filters stages", () => {
  const jobs = normalizeJobs([
    { id: "m1", title: "Milestone", milestone: true, stage: "open" },
    { id: "j-done", title: "Done job", stage: "done", owner: "agent:codex", last: { ts: 300 } },
    { id: "j-blk", title: "Blocked job", stage: "blocked", owner: "agent:antigravity", blocked_on: { note: "needs GO" }, last: { ts: 100 } },
    { id: "j-act", title: "Active job", stage: "active", plan: "launch", last: { ts: 200 } },
    { id: "j-unk", title: "Mystery", stage: "custom" },
  ]);
  assert.deepEqual(jobs.map((j) => j.id), ["j-blk", "j-act", "j-done", "j-unk"]);
  assert.equal(jobs[0].owner, "antigravity");
  assert.equal(jobs[0].blockedNote, "needs GO");
  assert.deepEqual(stageCounts(jobs), { all: 4, active: 1, blocked: 1, open: 1, done: 1 });
  assert.deepEqual(filterJobsByStage(jobs, "blocked").map((j) => j.id), ["j-blk"]);
  assert.deepEqual(filterJobsByStage(jobs, "open").map((j) => j.id), ["j-unk"]);
  assert.deepEqual(normalizeJobs(null), []);
});

test("agents-model: normalizes shift presence, doing, recap, and counts", () => {
  const agents = normalizeAgents([
    { id: "antigravity", seen: { state: "active", label: "Active" }, now: { doing: "Wave 3" }, last: { ts: 500, via: "antigravity" } },
    { id: "codex", seen: { state: "idle", label: "Idle 20m" }, recap: { summary: "Reviewed PR", mode: "manual" }, last: { ts: 200 } },
    { id: "old", seen: { state: "quiet", label: "Quiet" } },
  ]);
  assert.equal(agents[0].id, "antigravity");
  assert.equal(agents[0].doing, "Wave 3");
  assert.equal(agents[1].recapSummary, "Reviewed PR");
  assert.deepEqual(agentCounts(agents), { total: 3, active: 1, idle: 1, quiet: 1 });
  assert.deepEqual(normalizeAgents(undefined), []);
});

test("activity-model: maps 6 semantic kind groups, sorts newest first, filters cleanly", () => {
  assert.equal(entryKindGroup("progress"), "work");
  assert.equal(entryKindGroup("handoff"), "handoff");
  assert.equal(entryKindGroup("approval"), "decision");
  assert.equal(entryKindGroup("problem"), "error");
  assert.equal(entryKindGroup("unknown-kind"), "neutral");

  const entries = normalizeEntries([
    { ts: 100, kind: "handoff", by: "agent:grok", summary: "Pass work", where: "job:x", trail: "t1" },
    { ts: 300, kind: "fix", by: "agent:antigravity", summary: "Fixed contrast", where: "job:y", trail: "t2" },
    { ts: 200, kind: "decided", by: "human:mikey", summary: "Approved", where: "job:z" },
  ]);
  assert.deepEqual(entries.map((e) => e.ts), [300, 200, 100]);
  assert.equal(entries[0].actor, "antigravity");
  assert.deepEqual(groupCounts(entries), { all: 3, work: 0, handoff: 1, signal: 0, decision: 1, error: 1, system: 0 });
  assert.equal(filterEntriesByGroup(entries, "error").length, 1);
});

test("schedule-model: derives real shifts and dated jobs without inventing cron rows", () => {
  const { shifts, upcoming } = buildSchedule(
    [{ id: "antigravity", seen: { state: "active", label: "Active" }, shift: { shift: "s1", surface: "antigravity", ts: 1000 }, now: { doing: "Polish" } }],
    [
      { id: "m1", title: "M1", milestone: true, stage: "open", due: "2026-11-26" },
      { id: "j1", title: "Done item", stage: "done", due: "2026-11-20" },
      { id: "j2", title: "Earlier item", stage: "active", due: "2026-11-24" },
      { id: "j3", title: "Undated", stage: "active" },
    ],
  );
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].agent, "antigravity");
  assert.deepEqual(upcoming.map((u) => u.id), ["j2", "m1"]);
  assert.equal(upcoming[1].isMilestone, true);
  assert.deepEqual(buildSchedule([], []), { shifts: [], upcoming: [] });
});

test("access-model: builds read-only flags and redacted snippets with zero secrets", () => {
  const flags = buildAccessFlags({ space: "madez", keys: 42, ping_ms: 14, compat: true, mirror: false }, "madez");
  assert.equal(flags.length, 4);
  assert.equal(flags.find((f) => f.id === "storage").value, "Healthy");
  assert.equal(flags.find((f) => f.id === "compat").value, "On");
  assert.equal(flags.find((f) => f.id === "mirror").value, "Off");

  const snippets = buildConnectSnippets("madez");
  assert.equal(snippets.length, 4);
  for (const s of snippets) {
    assert.ok(!s.command.includes("upstash"), "snippets must never contain real credentials");
    assert.ok(!s.command.includes("Bearer "), "snippets must never contain bearer tokens");
  }
});
