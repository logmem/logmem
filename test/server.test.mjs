import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { writeDecision } from "../src/core/tools.mjs";

// Test-only HMAC key for human decisions (writeDecision fails closed without one).
process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";

const call = async (lm, name, args) => {
  const r = await lm.callTool(name, args);
  return r.structuredContent;
};

function clock(start = 1791712800000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test("first call of a session auto-Starts a shift", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", surface: "codex", sessionId: "s1", defaultAgent: "relay" });
  const r = await call(lm, "logmem_note", { where: "channel:ops", summary: "hello" });
  assert.equal(r.ok, true);
  assert.equal(r.shift_events[0].type, "auto-start");
  assert.equal(r.entry.by, "agent:relay");
  assert.equal(r.entry.byline, "relay (via codex)");
  const log = (await call(lm, "logmem_view", { ref: "agent:relay" })).log;
  assert.equal(log.at(-1).kind, "started");
});

test("30 min idle -> auto Recap of the old shift, then a fresh auto Start", async () => {
  const now = clock();
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "acme", surface: "claude-code", sessionId: "s2", now });
  await call(lm, "logmem_start", { agent: "quill" });
  await call(lm, "logmem_note", { where: "channel:ops", summary: "draft started", kind: "progress" });
  now.advance(31 * 60 * 1000);
  const r = await call(lm, "logmem_view", { ref: "channel:ops" });
  assert.deepEqual(r.shift_events.map((e) => e.type), ["auto-recap", "auto-start"]);
  const brief = await call(lm, "logmem_brief", {});
  assert.equal(brief.recap.mode, "auto");
  assert.equal(brief.recap.reason, "idle");
  assert.equal(brief.agent, "quill", "same agent continues");
});

test("stdio sweep writes the idle Recap without another call", async () => {
  const now = clock();
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", sessionId: "s3", now });
  await call(lm, "logmem_start", { agent: "tally" });
  now.advance(29 * 60 * 1000);
  assert.equal(await lm.shifts.sweep(), false);
  now.advance(2 * 60 * 1000);
  assert.equal(await lm.shifts.sweep(), true);
  assert.equal((await lm.store.getRecap("tally")).reason, "idle");
});

test("persona switch: logmem start <agent> recaps the previous agent first", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", surface: "claude-code", sessionId: "s4" });
  await call(lm, "logmem_start", { agent: "atlas" });
  await call(lm, "logmem_note", { where: "channel:ops", summary: "planned week" });
  const r = await call(lm, "logmem_start", { agent: "quill" });
  assert.equal(r.switch[0].type, "switch-recap");
  assert.equal(r.switch[0].agent, "atlas");
  assert.equal(r.started.agent, "quill");
  assert.equal(r.brief.agent, "quill");
  const atlas = await lm.store.getRecap("atlas");
  assert.equal(atlas.reason, "switch to quill");
  const note = await call(lm, "logmem_note", { where: "channel:ops", summary: "now quill" });
  assert.equal(note.entry.byline, "quill (via claude-code)");
  const same = await call(lm, "logmem_start", { agent: "quill" });
  assert.equal(same.switch[0].type, "already-started");
});

test("clean room: start, note, assign, handoff, accept, ask, decide, stage, recap, read back — logmem_* only", async () => {
  const redis = createMemoryRedis();
  const a = createLogmem({ redis, space: "fieldnotes", surface: "claude-code", sessionId: "atlas-session" });
  const q = createLogmem({ redis, space: "fieldnotes", surface: "codex", sessionId: "quill-session" });

  await call(a, "logmem_start", { agent: "atlas" });
  const job = await call(a, "logmem_assign", { job: "issue-14", title: "Launch newsletter issue 14" });
  assert.equal(job.entry.kind, "assigned");
  const ho = await call(a, "logmem_handoff", { to: "quill", where: "job:issue-14", summary: "Draft issue 14", origin: job.entry.trail, create_agent: true });

  const start = await call(q, "logmem_start", { agent: "quill" });
  assert.equal(start.brief.handoffs_to_me.length, 1);
  assert.equal(start.brief.follows["job:issue-14"].role, "owner");
  await call(q, "logmem_note", { where: "job:issue-14", kind: "accepted", summary: "quill picked up issue 14", origin: ho.trail });
  assert.equal((await call(q, "logmem_brief", {})).handoffs_to_me.length, 0, "accepted clears the waiting handoff");
  await call(q, "logmem_update", { job: "issue-14", summary: "Draft done" });
  const ask = await call(q, "logmem_ask", { question: "Send to 2,184 subscribers?", action: "POST /v1/campaigns/iss-14/send", reversible: false, where: "job:issue-14" });
  assert.match(ask.instruction, /Do not perform/);
  await writeDecision(a.store, ask.trail, { verdict: "approve", note: "Approved", by: "human:mikey" });
  await call(q, "logmem_stage", { job: "issue-14", stage: "done", note: "scheduled Tue 9am" });
  const recap = await call(q, "logmem_recap", { notes: "Issue 14 scheduled.", next: ["subject-line test for 15"] });
  assert.equal(recap.recap.mode, "manual");

  const open = await call(a, "logmem_open", { job: "issue-14" });
  assert.equal(open.now.stage, "done");
  assert.equal(open.now.owner, "agent:quill");
  assert.deepEqual(
    open.log.map((e) => e.kind).reverse(),
    ["assigned", "handoff", "accepted", "progress", "approval", "decided", "done"],
  );
  const decided = open.log.find((e) => e.kind === "decided");
  assert.equal(decided.origin, ask.trail);
  assert.equal(open.log.find((e) => e.kind === "accepted").byline, "quill (via codex)");

  const feed = await call(a, "logmem_feed", { refs: ["job:issue-14", "agent:quill"], limit: 100 });
  assert.ok(feed.entries.length >= 10);
  assert.deepEqual((await call(a, "logmem_roster", {})).ids, ["atlas", "quill"]);
  assert.deepEqual((await call(a, "logmem_jobs", { stage: "done" })).jobs, ["issue-14"]);
  assert.equal((await call(a, "logmem_recall", { query: "subscribers send" })).results[0].kind, "approval");
  assert.equal((await call(q, "logmem_brief", {})).recap.summary, "Issue 14 scheduled.");
  for (const t of ["logmem_status", "logmem_bio", "logmem_follow"]) assert.ok(a.tools.find((x) => x.name === t));
  assert.equal((await call(a, "logmem_status", { now: { doing: "week plan" } })).now.doing, "week plan");
  assert.equal((await call(a, "logmem_bio", { who: { role: "planner" } })).who.role, "planner");
  assert.ok((await call(a, "logmem_follow", { action: "list" })).follows);
  assert.equal((await call(a, "logmem_connection", {})).space, "fieldnotes");
});

test("two spaces on one Redis never see each other", async () => {
  const redis = createMemoryRedis();
  const one = createLogmem({ redis, space: "one", sessionId: "x" });
  const two = createLogmem({ redis, space: "two", sessionId: "x" });
  await call(one, "logmem_start", { agent: "quill" });
  await call(one, "logmem_note", { where: "channel:secret", summary: "space one only" });
  await call(one, "logmem_assign", { job: "j1", title: "one's job" });
  await call(two, "logmem_start", { agent: "quill" });
  assert.equal((await call(two, "logmem_view", { ref: "channel:secret" })).log.length, 0);
  assert.deepEqual((await call(two, "logmem_jobs", {})).jobs, []);
  assert.equal((await call(two, "logmem_recall", { query: "space one only" })).results.length, 0);
  assert.equal((await call(two, "logmem_brief", { agent: "quill" })).log.filter((e) => e.kind !== "started").length, 0);
  const rm = await call(two, "logmem_remove", { key: "lm:one:channel:secret:log", confirm: true });
  assert.equal(rm.ok, false);
  assert.equal((await call(one, "logmem_view", { ref: "channel:secret" })).log.length, 1);
  assert.throws(() => createLogmem({ redis, space: "three", spaces: ["one"], sessionId: "y" }), /not in the allowed list/);
  assert.equal((await call(two, "logmem_spaces", {})).spaces.join(), "two");
});

test("compat mode: acmi_* tools write LogMem shape and read back ACMI shape", async () => {
  const redis = createMemoryRedis();
  // The writer is this session's agent (codex), never the caller's `source`.
  const lm = createLogmem({ redis, space: "madez", compat: true, sessionId: "c", defaultAgent: "codex" });
  assert.equal(lm.tools.length, 41);
  await call(lm, "acmi_event", { namespace: "thread", id: "agent-coordination", source: "agent:codex", kind: "handoff-ack", summary: "ack", correlationId: "x-1", parentCorrelationId: "p-1" });
  const raw = await redis("ZRANGE", "lm:madez:channel:agent-coordination:log", 0, -1);
  const stored = JSON.parse(raw[0]);
  assert.equal(stored.kind, "accepted");
  assert.equal(stored.trail, "x-1");
  assert.equal(stored.origin, "p-1");
  assert.equal(stored.by, "agent:codex");
  const got = await call(lm, "acmi_get", { namespace: "thread", id: "agent-coordination" });
  assert.deepEqual(
    { kind: got.timeline_recent[0].kind, correlationId: got.timeline_recent[0].correlationId, parentCorrelationId: got.timeline_recent[0].parentCorrelationId, source: got.timeline_recent[0].source },
    { kind: "handoff-ack", correlationId: "x-1", parentCorrelationId: "p-1", source: "agent:codex" },
  );
  await call(lm, "acmi_work_signal", { id: "w1", signals: JSON.stringify({ status: "active" }) });
  await call(lm, "acmi_work_signal", { id: "w1", signals: JSON.stringify({ owner: "x" }) });
  assert.deepEqual((await call(lm, "acmi_work_get", { id: "w1" })).signals, { owner: "x" }, "ACMI signals replace, not merge");
  const del = await call(lm, "acmi_delete", { key: "acmi:madez:thread:agent-coordination:timeline" });
  assert.equal(del.key, "lm:madez:channel:agent-coordination:log");
  assert.equal(del.dry_run, true);
  const plain = createLogmem({ redis, space: "madez", sessionId: "d" });
  assert.equal(plain.tools.length, 22, "compat off: logmem_* only");
});

test("auto Recap counts the shift's own entries", async () => {
  const now = clock();
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", sessionId: "s5", now });
  await call(lm, "logmem_start", { agent: "quill" });
  now.advance(1000);
  await call(lm, "logmem_note", { where: "agent:quill", summary: "one", kind: "progress" });
  now.advance(31 * 60 * 1000);
  await lm.shifts.sweep();
  const r = await lm.store.getRecap("quill");
  assert.match(r.summary, /1 progress/);
});

test("review fix: compat reads skip legacy twins of migrated entries", async () => {
  const redis = createMemoryRedis();
  const ev = { ts: 1791700000000, source: "agent:a", kind: "coord-note", correlationId: "t1", summary: "once" };
  await redis("ZADD", "acmi:madez:thread:c:timeline", ev.ts, JSON.stringify(ev));
  const lm = createLogmem({ redis, space: "madez", compat: true, sessionId: "m" });
  await lm.store.append("channel", "c", { ts: ev.ts, kind: "memo", by: "agent:a", trail: "t1", summary: "once" }); // the migrated copy
  assert.equal((await lm.store.readLog("channel", "c")).length, 1);
});

test("review fix: logmem_assign refuses to reset an existing job", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", sessionId: "a" });
  await call(lm, "logmem_start", { agent: "atlas" });
  await call(lm, "logmem_assign", { job: "j", title: "first" });
  await call(lm, "logmem_stage", { job: "j", stage: "active" });
  const again = await call(lm, "logmem_assign", { job: "j", title: "second" });
  assert.equal(again.ok, false);
  assert.equal((await call(lm, "logmem_open", { job: "j" })).now.stage, "active");
  assert.equal((await call(lm, "logmem_assign", { job: "j", title: "second", reopen: true })).ok, true);
});

test("review fix: a handoff older than 20 entries still shows in the Brief", async () => {
  const redis = createMemoryRedis();
  const a = createLogmem({ redis, space: "acme", sessionId: "a" });
  const q = createLogmem({ redis, space: "acme", sessionId: "q" });
  await call(a, "logmem_start", { agent: "atlas" });
  await call(a, "logmem_handoff", { to: "quill", summary: "old work", create_agent: true });
  await call(q, "logmem_start", { agent: "quill" });
  for (let i = 0; i < 30; i++) await call(q, "logmem_note", { where: "agent:quill", summary: `busy ${i}` });
  const b = await call(q, "logmem_brief", {});
  assert.equal(b.handoffs_to_me.length, 1);
  assert.equal(b.log.length, 20);
});
