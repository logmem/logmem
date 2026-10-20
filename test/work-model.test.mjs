// The work taxonomy (docs/superpowers/specs/2026-10-19-logmem-work-taxonomy-design.md):
// Plan, then Job, then Task or Decision. Every job is in a plan, every task
// and decision is on a job, blocked always has a reason, and a task or
// decision on a job blocks it until a person answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { writeDecision } from "../src/core/tools.mjs";
import { markDone, cantDo, getBlocker } from "../src/core/blockers.mjs";
import { planView } from "../src/http/view.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";

const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const setup = (opts = {}) => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "claude-code", defaultAgent: "claude-code", ...opts });
  return { redis, lm, store: createStore(redis, { space: "madez" }) };
};
const jobNow = (store, id) => store.getNow("job", id);
const WT = { steps: [{ title: "Open Vercel" }, { title: "Tick Preview" }] };

test("plans: a job with no plan is filed in general; unknown plans and paths are refused", async () => {
  const { lm } = setup();
  const r = await sc(lm, "logmem_assign", { job: "a", title: "A" });
  assert.equal(r.ok, true);
  assert.equal(r.who.plan, "general");
  assert.match(r.note, /filed in 'general'/);
  assert.match((await sc(lm, "logmem_assign", { job: "b", title: "B", details: { plan: "launch" } })).error, /no plan 'launch'.*Plans: general/);
  assert.match((await sc(lm, "logmem_assign", { job: "c", title: "C", details: { plan: "docs/plans/x.md" } })).error, /Not a path or a URL/);
  assert.equal((await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "Launch" })).ok, true);
  assert.match((await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "Again" })).error, /already exists/);
  assert.equal((await sc(lm, "logmem_assign", { job: "b", title: "B", details: { plan: "launch" } })).who.plan, "launch");
  assert.deepEqual((await sc(lm, "logmem_plan", {})).plans.map((p) => p.id), ["general", "launch"]);
});

test("blocked: needs blocked_on with a type and a note; moving on clears it", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  assert.match((await sc(lm, "logmem_stage", { job: "a", stage: "blocked", note: "stuck" })).error, /blocked needs blocked_on/);
  assert.match((await sc(lm, "logmem_stage", { job: "a", stage: "blocked", blocked_on: { type: "weather", note: "x" } })).error, /type must be one of/);
  const r = await sc(lm, "logmem_stage", { job: "a", stage: "blocked", blocked_on: { type: "agent", ref: "codex", note: "Review of PR 64" } });
  assert.equal(r.ok, true);
  assert.deepEqual((await jobNow(store, "a")).blocked_on, { type: "agent", ref: "codex", note: "Review of PR 64" });
  assert.match(r.entry.summary, /blocked on agent codex/);
  await sc(lm, "logmem_stage", { job: "a", stage: "active" });
  assert.equal((await jobNow(store, "a")).blocked_on, null);
});

test("warn mode: off-job asks and blocked with no reason go through with a warning", async () => {
  const { lm, store } = setup({ workRules: "warn" });
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  const s = await sc(lm, "logmem_stage", { job: "a", stage: "blocked", note: "no idea" });
  assert.equal(s.ok, true);
  assert.match(s.warning, /blocked needs blocked_on/);
  assert.equal((await jobNow(store, "a")).blocked_on.type, "external");
  const q = await sc(lm, "logmem_ask", { question: "Ship?", action: "deploy" });
  assert.equal(q.ok, true);
  assert.match(q.warning, /must be on a job/);
});

test("tasks and decisions must be on a job that exists; an ask defaults to the job in your Now", async () => {
  const { lm } = setup();
  assert.match((await sc(lm, "logmem_ask", { question: "Ship?", action: "deploy" })).error, /must be on a job/);
  assert.match((await sc(lm, "logmem_ask", { question: "Ship?", action: "deploy", where: "channel:ops" })).error, /must be on a job/);
  assert.match((await sc(lm, "logmem_ask", { question: "Ship?", action: "deploy", where: "job:nope" })).error, /does not exist/);
  assert.match((await sc(lm, "logmem_handoff", { to: "human:mikey", where: "channel:ops", summary: "Do it", walkthrough: WT })).error, /must be on a job/);
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship" });
  await sc(lm, "logmem_status", { now: { doing: "shipping", job: "job:ship" } });
  const q = await sc(lm, "logmem_ask", { question: "Ship?", action: "deploy" });
  assert.equal(q.ok, true);
  assert.equal(q.entry.where, "job:ship");
});

test("auto-link: a decision blocks its job; approve unblocks; defer keeps it blocked", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship" });
  await sc(lm, "logmem_stage", { job: "ship", stage: "active" });
  const q = await sc(lm, "logmem_ask", { question: "Deploy?", action: "vercel promote", where: "job:ship", reversible: true });
  assert.equal(q.job.stage, "blocked");
  assert.deepEqual((await jobNow(store, "ship")).blocked_on, { type: "decision", ref: q.trail, note: "Deploy?" });
  await writeDecision(store, q.trail, { verdict: "defer", by: "human:mikey" });
  assert.equal((await jobNow(store, "ship")).stage, "blocked", "defer is not yet");
  const d = await writeDecision(store, q.trail, { verdict: "approve", by: "human:mikey" });
  assert.equal(d.job.stage, "active");
  const now = await jobNow(store, "ship");
  assert.equal(now.blocked_on, null);
  assert.equal(now.last_outcome.needs_new_path, false);
});

test("auto-link: two open items keep the job blocked until both are answered; reject needs a new path", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship" });
  const t = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:ship", summary: "Set the env var", walkthrough: WT });
  assert.equal(t.job.blocked_on.type, "task");
  const q = await sc(lm, "logmem_ask", { question: "Deploy?", action: "vercel promote", where: "job:ship", reversible: true });
  await writeDecision(store, q.trail, { verdict: "reject", by: "human:mikey" });
  let now = await jobNow(store, "ship");
  assert.equal(now.stage, "blocked", "the task is still open");
  assert.equal(now.blocked_on.ref, t.trail);
  await markDone(store, t.trail, { by: "human:mikey" });
  now = await jobNow(store, "ship");
  assert.equal(now.stage, "active");
  assert.equal(now.waits.length, 0);
});

test("can't do: closes the task with a reason, writes the person's entry, and unblocks with needs_new_path", async () => {
  const { lm, store, redis } = setup();
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship" });
  const t = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:ship", summary: "Pay the invoice", walkthrough: WT });
  await assert.rejects(() => cantDo(store, t.trail, { by: "agent:claude-code", reason: "x" }), /only a person/);
  await assert.rejects(() => cantDo(store, t.trail, { by: "human:mikey", reason: " " }), /say why/);
  const rec = await cantDo(store, t.trail, { by: "human:mikey", reason: "No card on file" });
  assert.equal(rec.outcome, "cant_do");
  assert.equal((await getBlocker(store, t.trail)).done, true);
  const now = await jobNow(store, "ship");
  assert.equal(now.stage, "active");
  assert.equal(now.last_outcome.needs_new_path, true);
  const log = (await redis("ZRANGE", "lm:madez:job:ship:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(log.some((e) => e.kind === "feedback" && e.by === "human:mikey" && e.payload.cant_do === true));
});

test("Brief: needs_people lists open tasks and decisions with their job and plan", async () => {
  const { lm } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "Launch" });
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship", details: { plan: "launch" } });
  const t = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:ship", summary: "Set the env var", walkthrough: WT });
  const q = await sc(lm, "logmem_ask", { question: "Deploy?", action: "vercel promote", where: "job:ship" });
  const b = await sc(lm, "logmem_brief", {});
  const byType = Object.fromEntries(b.needs_people.map((r) => [r.type, r]));
  assert.deepEqual([byType.task.trail, byType.task.job, byType.task.plan, byType.task.progress], [t.trail, "ship", "launch", "0/2"]);
  assert.deepEqual([byType.decision.trail, byType.decision.job, byType.decision.plan], [q.trail, "ship", "launch"]);
  assert.equal(b.person_blockers.length, 1, "kept one release for older clients");
});

test("plan view: milestone replaces gate, old gate still reads, blocked_on shows on items", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "Launch" });
  await sc(lm, "logmem_assign", { job: "new", title: "New", details: { plan: "launch", track: "Build", milestone: "g2" } });
  await sc(lm, "logmem_assign", { job: "old", title: "Old", details: { plan: "launch", track: "Build", gate: "G2" } });
  await sc(lm, "logmem_stage", { job: "old", stage: "blocked", blocked_on: { type: "external", note: "Vendor outage" } });
  const v = await planView(store, "launch");
  const items = Object.fromEntries(v.tracks[0].items.map((i) => [i.id, i]));
  assert.equal(items.new.milestone, "g2");
  assert.equal(items.old.milestone, "G2");
  assert.equal(items.old.blocked_on.note, "Vendor outage");
});

test("tasks API: cant_do needs the intent header and a reason, and unblocks the job", async () => {
  const { mockRes, mockReq } = await import("./oauth-helpers.mjs");
  const { issueCookie } = await import("../src/http/admin-auth.mjs");
  const { createHandler } = await import("../api/blockers.mjs");
  const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "madez" };
  const cookie = issueCookie(ENV).split(";")[0];
  const { redis, lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship" });
  const t = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:ship", summary: "Pay", walkthrough: WT });
  const h = createHandler({ env: ENV, redis });
  const post = async (body, headers) => {
    const res = mockRes();
    await h(mockReq({ method: "POST", url: "/api/blockers", body, headers: { host: "logmem.si", cookie, ...headers } }), res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const w = { "x-logmem-intent": "blockers", origin: "https://logmem.si" };
  assert.equal((await post({ space: "madez", trail: t.trail, action: "cant_do", reason: "No card" }, {})).status, 403);
  assert.equal((await post({ space: "madez", trail: t.trail, action: "cant_do" }, w)).status, 400);
  const ok = await post({ space: "madez", trail: t.trail, action: "cant_do", reason: "No card" }, w);
  assert.equal(ok.body.blocker.outcome, "cant_do");
  assert.equal((await jobNow(store, "ship")).stage, "active");
});
