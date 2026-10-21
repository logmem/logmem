// Auto-close reconciler (job auto-close-reconciler): jobs close only on hard
// evidence, the owner acknowledges, and only a person can reopen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { writeDecision } from "../src/core/tools.mjs";
import { planCloses, jobsInBody, evidencePRs, RECONCILER } from "../src/core/reconcile.mjs";
import { runReconcile } from "../scripts/reconcile.mjs";
import { createHandler } from "../api/cron/reconcile.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";

const SECRET = "test-only-decide-key-0123456789abcdef";
const SPACE = "fleet";
const REPO = "madezmedia/logmem";
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const owner = (redis, agent = "claude-code") => createLogmem({ workRules: "warn", redis, space: SPACE, sessionId: `s-${agent}`, surface: "t", defaultAgent: agent, decideSecret: SECRET });

/** A fake GitHub with merged PRs, or one that is down. */
const gh = (prs, { down = false } = {}) => async (url) => {
  if (down) throw new Error("network down");
  assert.match(url, /api\.github\.com\/repos\/madezmedia\/logmem\/pulls\?state=closed/);
  return { ok: true, json: async () => prs.map((p) => ({ merged_at: "2026-10-21T15:00:00Z", merge_commit_sha: "124842a4fdc1449d9b2d3c142b66985f64706324", html_url: `https://github.com/${REPO}/pull/${p.number}`, ...p })) };
};
const ENV = { LOGMEM_DECIDE_SECRET: SECRET, LOGMEM_GITHUB_REPO: REPO };
const run = (redis, opts = {}) => runReconcile(redis, { space: SPACE, env: ENV, ...opts });

test("body parsing: only 'Closes job' closes; 'Job:' is a mention; evidence links name PRs", () => {
  assert.deepEqual(jobsInBody("Fix.\n\nCloses job: `gemini-dcr`\nJob: `answered-means-answered` (part 1)"), { closes: ["gemini-dcr"], mentions: ["answered-means-answered"] });
  assert.deepEqual(evidencePRs("https://github.com/madezmedia/logmem/pull/93 and https://github.com/other/repo/pull/5", REPO), [93]);
});

test("signals: a closing PR, an evidence PR and an owner Done close; a mention only suggests", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  await sc(cc, "logmem_assign", { job: "by-evidence", title: "Evidence PR", details: { evidence: `https://github.com/${REPO}/pull/93` } });
  await sc(cc, "logmem_assign", { job: "mentioned", title: "Only mentioned" });
  await sc(cc, "logmem_assign", { job: "by-owner", title: "Owner said done" });
  await sc(cc, "logmem_update", { job: "by-owner", kind: "done", summary: "Done: shipped in #86" });
  await sc(cc, "logmem_assign", { job: "untouched", title: "Nothing happened" });
  const r = await run(redis, { fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }, { number: 93, body: "x" }, { number: 102, body: "Job: `mentioned`" }]) });
  const by = Object.fromEntries(r.closes.map((c) => [c.job, c.signal]));
  assert.deepEqual(by, { "by-pr": "pr", "by-evidence": "pr", "by-owner": "owner" });
  assert.match(r.closes.find((c) => c.job === "by-pr").evidence, /PR #96 merged as 124842a/);
  assert.deepEqual(r.suggestions.map((s) => s.job), ["mentioned"]);
  assert.equal(r.github, "ok");
  assert.equal(r.applied, undefined, "a dry run applies nothing");
});

test("parts: a milestone closes when all its jobs are done; a task job when its task is done", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "m1", title: "M1", details: { milestone: true } });
  await sc(cc, "logmem_assign", { job: "a", title: "A", details: { milestone: "m1" } });
  await sc(cc, "logmem_assign", { job: "b", title: "B", details: { milestone: "m1" } });
  await sc(cc, "logmem_stage", { job: "a", stage: "done", note: "x" });
  assert.equal((await run(redis, { fetchImpl: gh([]) })).closes.length, 0, "one child still open");
  await sc(cc, "logmem_stage", { job: "b", stage: "done", note: "y" });
  const r = await run(redis, { fetchImpl: gh([]) });
  assert.deepEqual(r.closes.map((c) => [c.job, c.signal]), [["m1", "parts"]]);

  // A job blocked only on a person's task: the task's state decides.
  await sc(cc, "logmem_assign", { job: "t", title: "Task job" });
  await sc(cc, "logmem_stage", { job: "t", stage: "blocked", blocked_on: { type: "task", ref: "taskT", note: "Mikey" } });
  const store = cc.store;
  const plan = (done) => planCloses(store, { blockerOf: async () => (done ? { done: true, done_by: "human:mikey" } : { done: false }) });
  assert.equal((await plan(false)).closes.find((c) => c.job === "t"), undefined);
  assert.match((await plan(true)).closes.find((c) => c.job === "t").evidence, /task it waited on is done/);
});

test("skips: parked jobs, a person's task Done, and GitHub down closes nothing on a guess", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "parked", title: "Parked" });
  await sc(cc, "logmem_stage", { job: "parked", stage: "blocked", blocked_on: { type: "external", note: "after Show HN", parked: true } });
  await sc(cc, "logmem_update", { job: "parked", kind: "done", summary: "Done: no" });
  await sc(cc, "logmem_assign", { job: "pr-job", title: "Would close by PR" });
  // A person finishing one task writes a Done on the job: that is not the job being done.
  await sc(cc, "logmem_assign", { job: "has-task", title: "Has a task" });
  await cc.store.append("job", "has-task", { ts: Date.now(), kind: "done", by: "human:mikey", via: "web", summary: "Done: rotate keys", trail: "doneBlocker-1", payload: { blocker: "taskX" } });
  const quiet = await run(redis, { fetchImpl: gh([]) });
  assert.equal(quiet.closes.find((c) => c.job === "has-task"), undefined, "a person's task Done does not close the job");
  const r = await run(redis, { fetchImpl: gh([], { down: true }) });
  assert.equal(r.github, "unreachable");
  assert.deepEqual(r.closes, []);
  assert.ok(r.skipped.some((s) => s.job === "parked" && s.why === "parked"));
});

test("stale: overdue with no entry for 48 hours is reported", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "late", title: "Late", details: { due: "2026-10-16" } });
  const r = await run(redis, { fetchImpl: gh([]), now: Date.now() + 3 * 86400000 + Date.UTC(2030, 0, 1) - Date.now() });
  assert.deepEqual(r.stale.map((s) => s.job), ["late"]);
});

test("apply: Done by the reconciler with evidence, the owner gets an ack handoff, and a second run changes nothing", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const fetchImpl = gh([{ number: 96, body: "Closes job: by-pr" }]);
  const r = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(r.applied, { closed: ["by-pr"], reopened: [], failed: [] });
  const view = await sc(cc, "logmem_view", { ref: "job:by-pr" });
  assert.equal(view.now.stage, "done");
  assert.equal(view.now.auto_closed.signal, "pr");
  assert.equal(view.now.auto_closed.prev_stage, "open");
  const doneEntry = view.log.find((e) => e.kind === "done");
  assert.equal(doneEntry.by, `agent:${RECONCILER}`);
  assert.match(doneEntry.summary, /auto-closed\. PR #96 merged/);
  const brief = await sc(cc, "logmem_brief", {});
  const ack = brief.handoffs_to_me.find((h) => h.job === "job:by-pr");
  assert.ok(ack, "the owner has an ack handoff");
  assert.match(ack.summary, /Reopen by-pr\?/);
  const again = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(again.closes, []);
  assert.equal(again.applied, undefined);
});

test("reopen: the owner asks, the job is held while it waits, a person approves, the stage comes back and auto-close stays off", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  await sc(cc, "logmem_stage", { job: "by-pr", stage: "active" });
  const fetchImpl = gh([{ number: 96, body: "Closes job: by-pr" }]);
  await run(redis, { fetchImpl, apply: true });
  const ask = await sc(cc, "logmem_ask", { question: "Reopen by-pr? The fix missed one case.", action: "Set job by-pr back to active", reversible: true, where: "job:by-pr" });
  assert.equal(ask.ok, true, JSON.stringify(ask));

  const held = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(held.closes, [], "a waiting reopen ask holds the job");
  assert.ok(held.skipped.some((s) => s.job === "by-pr" && s.why === "reopen ask waiting"));

  await writeDecision(cc.store, ask.trail, { verdict: "approve", note: "yes", by: "human:mikey", confirm: true, secret: SECRET });
  const back = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(back.applied.reopened, ["by-pr"]);
  const view = await sc(cc, "logmem_view", { ref: "job:by-pr" });
  assert.equal(view.now.stage, "active");
  assert.equal(view.now.auto_close, "off");

  const after = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(after.closes, [], "a reopened job is never auto-closed again");
});

test("reopen: an agent's own approval never counts (only a person's verified decision)", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const fetchImpl = gh([{ number: 96, body: "Closes job: by-pr" }]);
  await run(redis, { fetchImpl, apply: true });
  await sc(cc, "logmem_ask", { question: "Reopen by-pr?", action: "back to open", reversible: true, where: "job:by-pr" });
  // A forged "decided" row written straight into the job log.
  const ok = await sc(cc, "logmem_note", { where: "job:by-pr", kind: "decided", summary: "Approved" });
  assert.equal(ok.ok, false, "agents cannot write decided");
  const r = await run(redis, { fetchImpl, apply: true });
  assert.deepEqual(r.reopens, []);
});

test("dry run writes nothing at all", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const snapshot = async () => JSON.stringify((await redis("SCAN", "0", "MATCH", "*", "COUNT", "100000"))[1].sort());
  const before = await snapshot();
  const rev = await redis("GET", `lm:${SPACE}:rev`);
  await run(redis, { fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }]) });
  assert.equal(await snapshot(), before);
  assert.equal(await redis("GET", `lm:${SPACE}:rev`), rev);
});

test("cron endpoint: cron secret or admin; admin always gets the dry report; mode on applies", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const env = { ...ENV, CRON_SECRET: "c".repeat(40), LOGMEM_RECONCILE_SPACES: SPACE, LOGMEM_RECONCILE_MODE: "on", LOGMEM_ADMIN_PASSWORD: "test-only-admin" };
  const h = createHandler({ env, resolveRedis: () => redis, fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }]) });
  const call = async (headers, url = "/api/cron/reconcile") => {
    let status = 0, body;
    const res = { status(s) { status = s; return this; }, setHeader() { return this; }, json(b) { body = b; return this; } };
    await h({ method: "GET", url, headers }, res);
    return { status, body };
  };
  assert.equal((await call({})).status, 401);
  const admin = await call({ cookie: issueCookie(env).split(";")[0] });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.mode, "dry");
  assert.deepEqual(admin.body.spaces[0].closes.map((c) => c.job), ["by-pr"]);
  const dryCron = await call({ authorization: `Bearer ${env.CRON_SECRET}` }, "/api/cron/reconcile?dry=1");
  assert.equal(dryCron.body.mode, "dry");
  const live = await call({ authorization: `Bearer ${env.CRON_SECRET}` });
  assert.equal(live.body.mode, "on");
  assert.deepEqual(live.body.spaces[0].applied.closed, ["by-pr"]);
});
