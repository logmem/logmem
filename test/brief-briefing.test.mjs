// brief-briefing.test.mjs — a Brief is a briefing, not a snapshot.
//
// Covers the five changes:
//   1. start takes a mode, and offers the choice when none is given
//   2. the Brief says what changed since the last shift (including job comments,
//      which used to be invisible to the owner)
//   3. a Now that names a finished job is flagged
//   4. what to do next is ranked, handoffs first
//   5. the Brief ends with a question that names the first thing to do

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const call = async (lm, n, a = {}) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis, opts = {}) =>
  createLogmem({ redis, space: "fleet", sessionId: opts.session || "s1", surface: "test", ...opts });

test("start with no mode starts quiet and offers the choice", async () => {
  const lm = lmFor(createMemoryRedis(), { defaultAgent: "quill" });
  const r = await call(lm, "logmem_start", {});
  assert.equal(r.ok, true);
  assert.equal(r.mode, "quiet");
  assert.match(r.ask_operator, /fleet sync/i, "the operator is offered fleet sync");
  assert.ok(r.brief, "a brief still comes back");
});

test("start with mode fleet loads channel activity; operator adds what needs a human", async () => {
  const redis = createMemoryRedis();
  const fleet = await call(lmFor(redis, { defaultAgent: "quill" }), "logmem_start", { mode: "fleet" });
  assert.equal(fleet.mode, "fleet");
  assert.equal(fleet.ask_operator, undefined, "no choice offered when a mode is given");
  assert.ok(fleet.brief.fleet, "fleet snapshot present");
  assert.equal(fleet.brief.fleet.channel, "agent-coordination");
  assert.ok(Array.isArray(fleet.brief.fleet.active));

  const op = await call(lmFor(redis, { session: "s2", defaultAgent: "quill" }), "logmem_start", { mode: "operator" });
  assert.equal(op.mode, "operator");
  assert.ok(Array.isArray(op.brief.needs_human), "operator mode lists what needs a human");
  assert.ok(op.brief.fleet, "operator mode includes fleet");
});

test("since_last_shift counts a comment on a job the agent follows", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { session: "q", defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });

  await call(quill, "logmem_assign", { job: "probe-job", title: "A job quill follows" });
  await call(quill, "logmem_follow", { action: "follow", ref: "job:probe-job" });

  // Another agent comments on the job — the case that used to be invisible.
  const reed = lmFor(redis, { session: "r", defaultAgent: "reed" });
  await call(reed, "logmem_start", { mode: "quiet" });
  await call(reed, "logmem_note", { where: "job:probe-job", kind: "feedback", summary: "A comment from another agent." });

  // A later shift sees it as a change, not as a static field.
  const again = lmFor(redis, { session: "q2", defaultAgent: "quill" });
  const b = await call(again, "logmem_start", { mode: "quiet" });
  assert.ok(b.brief.since_last_shift, "the brief carries a delta");
  assert.ok(b.brief.since_last_shift.job_activity >= 1, `expected the comment to count, got ${JSON.stringify(b.brief.since_last_shift)}`);
  const touched = b.brief.since_last_shift.jobs.map((j) => j.ref);
  assert.ok(touched.includes("job:probe-job"), "the job is named in the delta");
});

test("a Now that names a finished job is flagged stale", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis, { defaultAgent: "quill" });
  await call(lm, "logmem_start", { mode: "quiet" });
  await call(lm, "logmem_assign", { job: "finished-job", title: "Work that is already done" });
  await call(lm, "logmem_status", { now: { doing: "working it", job: "job:finished-job" } });
  await call(lm, "logmem_stage", { job: "finished-job", stage: "done" });

  const b = await call(lm, "logmem_brief", {});
  assert.ok(b.stale_now, "the stale Now is reported");
  assert.equal(b.stale_now.job, "finished-job");
  assert.equal(b.stale_now.stage, "done");
  assert.match(b.ask, /stale/i, "the question leads with the stale Now");
});

test("do_next puts a handoff first and the ask names it", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { session: "q", defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });
  await call(quill, "logmem_assign", { job: "handoff-job", title: "A job with a handoff" });

  const reed = lmFor(redis, { session: "r", defaultAgent: "reed" });
  await call(reed, "logmem_start", { mode: "quiet" });
  await call(reed, "logmem_handoff", { to: "quill", where: "job:handoff-job", summary: "Please review the rollout lane." });

  const b = await call(lmFor(redis, { session: "q2", defaultAgent: "quill" }), "logmem_brief", {});
  assert.ok(b.do_next.length > 0, "there is something to do");
  assert.equal(b.do_next[0].type, "handoff", "a waiting handoff ranks first");
  assert.match(b.ask, /review the rollout lane/i, "the question names the work");
});

test("a brand-new space gets a seed hint, and a space with a job does not", async () => {
  const redis = createMemoryRedis();
  const first = await call(lmFor(redis, { defaultAgent: "quill" }), "logmem_start", { mode: "quiet" });
  assert.equal(first.brief.seed.needed, true);
  assert.match(first.brief.seed.skill, /logmem-seed-space\/SKILL\.md$/);
  assert.match(first.brief.ask, /seed/i);
  const lm = lmFor(redis, { session: "s2", defaultAgent: "quill" });
  await call(lm, "logmem_start", { mode: "quiet" });
  await call(lm, "logmem_assign", { job: "first-job", title: "First job" });
  const next = await call(lmFor(redis, { session: "s3", defaultAgent: "quill" }), "logmem_start", { mode: "quiet" });
  assert.equal(next.brief.seed, undefined);
});
