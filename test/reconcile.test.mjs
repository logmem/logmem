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
  return { ok: true, json: async () => prs.map((p) => ({ merged_at: new Date(Date.now() + 60000).toISOString(), merge_commit_sha: "124842a4fdc1449d9b2d3c142b66985f64706324", html_url: `https://github.com/${REPO}/pull/${p.number}`, ...p })) };
};
const ENV = { LOGMEM_DECIDE_SECRET: SECRET, LOGMEM_GITHUB_REPO: REPO };
const run = (redis, opts = {}) => runReconcile(redis, { space: SPACE, env: ENV, ...opts });

test("body parsing: only 'Closes job' closes; 'Job:' is a mention; evidence links name PRs", () => {
  assert.deepEqual(jobsInBody("Fix.\n\nCloses job: `gemini-dcr`\nJob: `answered-means-answered` (part 1)"), { closes: ["gemini-dcr"], mentions: ["answered-means-answered"] });
  assert.deepEqual(evidencePRs("https://github.com/madezmedia/logmem/pull/93 and https://github.com/other/repo/pull/5", REPO), [93]);
});

test("signals: only a closing PR closes; evidence PRs, owner Done, mentions and work after the merge only suggest", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  await sc(cc, "logmem_assign", { job: "by-evidence", title: "Evidence PR", details: { evidence: `https://github.com/${REPO}/pull/93` } });
  await sc(cc, "logmem_assign", { job: "mentioned", title: "Only mentioned" });
  await sc(cc, "logmem_assign", { job: "by-owner", title: "Owner said done" });
  await sc(cc, "logmem_update", { job: "by-owner", kind: "done", summary: "Done: shipped in #86" });
  await sc(cc, "logmem_assign", { job: "untouched", title: "Nothing happened" });
  await sc(cc, "logmem_assign", { job: "went-on", title: "Work after the merge" });
  const merged = new Date(Date.now() - 3 * 3600000).toISOString();
  const r = await run(redis, { fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }, { number: 93, body: "x" }, { number: 102, body: "Job: `mentioned`" }, { number: 110, body: "Closes job: went-on", merged_at: merged }]) });
  const by = Object.fromEntries(r.closes.map((c) => [c.job, c.signal]));
  assert.deepEqual(by, { "by-pr": "pr" });
  assert.match(r.closes.find((c) => c.job === "by-pr").evidence, /PR #96 merged as 124842a/);
  assert.deepEqual(r.suggestions.map((s) => [s.job, s.signal]).sort(), [["by-evidence", "pr-evidence"], ["by-owner", "owner"], ["mentioned", "pr-mention"], ["went-on", "pr-later"]]);
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

test("stale: overdue with no entry for 48 hours is reported (ISO and 'Oct 16' dates)", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "late", title: "Late", details: { due: "2026-10-16" } });
  await sc(cc, "logmem_assign", { job: "late2", title: "Late too", details: { due: "Oct 16" } });
  const r = await run(redis, { fetchImpl: gh([]), now: Date.now() + 3 * 86400000 });
  assert.deepEqual(r.stale.map((s) => s.job).sort(), ["late", "late2"]);
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

test("dry run changes no job: only the report the app reads is saved", async () => {
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const keys = async () => (await redis("SCAN", "0", "MATCH", "*", "COUNT", "100000"))[1].sort();
  const before = await keys();
  const values = async (ks) => Promise.all(ks.map(async (k) => JSON.stringify(await redis("TYPE", k) === "string" ? await redis("GET", k) : await redis("ZRANGE", k, 0, -1).catch(() => null))));
  const vBefore = await values(before);
  const rev = await redis("GET", `lm:${SPACE}:rev`);
  await run(redis, { fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }]) });
  const after = await keys();
  assert.deepEqual(after.filter((k) => !before.includes(k)), [`lm:${SPACE}:reconcile:report`]);
  assert.deepEqual(await values(before), vBefore);
  assert.equal(await redis("GET", `lm:${SPACE}:rev`), rev);
  const rep = JSON.parse(await redis("GET", `lm:${SPACE}:reconcile:report`));
  assert.equal(rep.mode, "dry");
});

test("Looks done? in the app: Needs you lists suggestions and stale jobs; Close it and Still open answer them", async () => {
  const { needsView } = await import("../src/http/view.mjs");
  const { confirmDone, keepOpen } = await import("../src/http/work.mjs");
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "said-done", title: "Owner said done" });
  await sc(cc, "logmem_update", { job: "said-done", kind: "done", summary: "Done: shipped" });
  await sc(cc, "logmem_assign", { job: "maybe", title: "Maybe done" });
  await sc(cc, "logmem_update", { job: "maybe", kind: "done", summary: "Done: one step" });
  await sc(cc, "logmem_assign", { job: "late", title: "Late", details: { due: "2026-10-01" } });
  const at = Date.now() + 3 * 86400000;
  await run(redis, { fetchImpl: gh([]), now: at });
  const needs = async () => needsView(cc.store, redis, SPACE, { secret: SECRET });
  let n = await needs();
  assert.deepEqual(n.items.filter((i) => i.type === "suggestion").map((i) => i.job).sort(), ["maybe", "said-done"]);
  assert.deepEqual(n.stale, ["late"]);

  // Only a person can answer, and Close it moves the job to done with their entry.
  await assert.rejects(confirmDone(cc.store, { job: "said-done", by: "agent:claude-code" }), /only a person/);
  const c = await confirmDone(cc.store, { job: "said-done", by: "human:mikey", note: "checked" });
  assert.equal(c.entry.by, "human:mikey");
  assert.equal((await cc.store.getNow("job", "said-done")).stage, "done");
  // Still open hides it now, and the reconciler stops suggesting it until the job changes.
  await keepOpen(cc.store, { job: "maybe", by: "human:mikey", note: "two steps left" });
  n = await needs();
  assert.deepEqual(n.items.filter((i) => i.type === "suggestion").map((i) => i.job), []);
  const again = await run(redis, { fetchImpl: gh([]), now: at + 1000 });
  assert.equal(again.suggestions.find((x) => x.job === "maybe"), undefined);
  assert.ok(again.skipped.some((x) => x.job === "maybe" && /still open/.test(x.why)));
  // A new Done from the owner brings the suggestion back.
  await sc(cc, "logmem_update", { job: "maybe", kind: "done", summary: "Done: all steps" });
  assert.ok((await run(redis, { fetchImpl: gh([]) })).suggestions.some((x) => x.job === "maybe"));
});

test("Close it refuses a job that still waits on a task or a decision", async () => {
  const { confirmDone } = await import("../src/http/work.mjs");
  const redis = createMemoryRedis();
  const cc = owner(redis);
  await sc(cc, "logmem_assign", { job: "waits", title: "Waits" });
  await sc(cc, "logmem_stage", { job: "waits", stage: "blocked", blocked_on: { type: "decision", ref: "askX", note: "Mikey" } });
  await assert.rejects(confirmDone(cc.store, { job: "waits", by: "human:mikey" }), /waits on a task or a decision/);
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

test("a job the backend can't read is skipped and the run goes on", async () => {
  const inner = createMemoryRedis();
  const cc = owner(inner);
  await sc(cc, "logmem_assign", { job: "bad", title: "Bad" });
  await sc(cc, "logmem_assign", { job: "by-pr", title: "Closed by a PR" });
  const redis = (cmd, ...args) => {
    if (String(args[0] || "").includes(":job:bad:")) throw new Error("bad response body");
    return inner(cmd, ...args);
  };
  const r = await run(redis, { fetchImpl: gh([{ number: 96, body: "Closes job: by-pr" }]) });
  assert.deepEqual(r.closes.map((c) => c.job), ["by-pr"]);
  assert.ok(r.skipped.some((x) => x.job === "bad" && x.why === "unreadable"));
});
