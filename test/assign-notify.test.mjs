// assign-notify.test.mjs — owning a job means following it, and a reassignment tells the new owner.
//
// The gap these cover: logmem_handoff wrote to the receiver's agent log and made them follow the
// job, but logmem_assign did neither. So an agent never saw comments on its own jobs, and a
// reopen that changed the owner handed the work over silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const call = async (lm, n, a = {}) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis, opts = {}) =>
  createLogmem({ redis, space: "fleet", sessionId: opts.session || "s1", surface: "test", ...opts });

test("assigning a job makes the owner follow it", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });
  await call(quill, "logmem_assign", { job: "owned-job", title: "A job quill owns" });

  const b = await call(quill, "logmem_brief", {});
  assert.ok(b.follows["job:owned-job"], `expected the owner to follow the job, got ${JSON.stringify(Object.keys(b.follows))}`);
  assert.equal(b.follows["job:owned-job"].role, "owner");
});

test("a comment on a job reaches the owner's Brief without any manual follow", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { session: "q", defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });
  await call(quill, "logmem_assign", { job: "commented-job", title: "A job that gets a comment" });

  const reed = lmFor(redis, { session: "r", defaultAgent: "reed" });
  await call(reed, "logmem_start", { mode: "quiet" });
  await call(reed, "logmem_note", { where: "job:commented-job", kind: "feedback", summary: "A comment on quill's job." });

  const b = await call(lmFor(redis, { session: "q2", defaultAgent: "quill" }), "logmem_brief", {});
  assert.ok(b.since_last_shift.job_activity >= 1, `expected the comment to count, got ${JSON.stringify(b.since_last_shift)}`);
  assert.ok(b.since_last_shift.jobs.some((j) => j.ref === "job:commented-job"), "the job is named in the delta");
});

test("a reopen that changes the owner notifies the new owner", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { session: "q", defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });
  await call(quill, "logmem_assign", { job: "moving-job", title: "Work that changes hands" });

  const r = await call(quill, "logmem_assign", { job: "moving-job", title: "Work that changes hands", owner: "reed", reopen: true });
  assert.equal(r.ok, true);
  assert.ok(r.reassigned, "the response reports the notification");

  const reed = lmFor(redis, { session: "r2", defaultAgent: "reed" });
  await call(reed, "logmem_start", { mode: "quiet" });
  const b = await call(reed, "logmem_brief", {});
  const summaries = (b.handoffs_to_me || []).map((h) => h.summary);
  assert.ok(summaries.some((s) => /reassigned to you/i.test(s)), `expected a reassignment handoff, got ${JSON.stringify(summaries)}`);
  assert.ok(b.follows["job:moving-job"], "the new owner follows the job");
});

test("a reopen that keeps the same owner does not invent a handoff", async () => {
  const redis = createMemoryRedis();
  const quill = lmFor(redis, { defaultAgent: "quill" });
  await call(quill, "logmem_start", { mode: "quiet" });
  await call(quill, "logmem_assign", { job: "steady-job", title: "Stays with quill" });

  const r = await call(quill, "logmem_assign", { job: "steady-job", title: "Stays with quill", owner: "quill", reopen: true });
  assert.equal(r.ok, true);
  assert.equal(r.reassigned, undefined, "no notification when the owner did not change");

  const b = await call(quill, "logmem_brief", {});
  assert.equal((b.handoffs_to_me || []).length, 0, "no handoff appeared");
});
