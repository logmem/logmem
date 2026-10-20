// Live app, server side (docs/superpowers/specs/2026-10-19-logmem-live-app-design.md):
// the rev counter, /api/pulse, /api/needs, /api/nudge, /api/unblock and the Home view.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore, revKey } from "../src/core/store.mjs";
import { writeDecision } from "../src/core/tools.mjs";
import { homeView, needsView } from "../src/http/view.mjs";
import { mockRes, mockReq } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/work.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";
const SECRET = process.env.LOGMEM_DECIDE_SECRET;
const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "madez", LOGMEM_DECIDE_SECRET: SECRET, LOGMEM_MIRROR_ACMI: "1", LOGMEM_MIRROR_SPACES: "madez" };
const cookie = issueCookie(ENV).split(";")[0];
const W = { cookie, "x-logmem-intent": "work", origin: "https://logmem.si" };
const WT = { steps: [{ title: "Open Vercel" }, { title: "Tick Preview" }] };

const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
function setup() {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "claude-code", defaultAgent: "claude-code" });
  return { redis, lm, store: createStore(redis, { space: "madez" }) };
}
const call = async (h, { method = "GET", url, body, headers = {} }) => {
  const res = mockRes();
  await h(mockReq({ method, url, body, headers: { host: "logmem.si", ...headers } }), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};
const logOf = async (redis, key) => (await redis("ZRANGE", key, "0", "-1")).map((x) => JSON.parse(x));

test("rev: every Who, Now and Log write bumps the space counter; a refused INCR never fails the write", async () => {
  const { redis, lm } = setup();
  const rev = async () => Number((await redis("GET", revKey("madez"))) || 0);
  const r0 = await rev();
  await sc(lm, "logmem_note", { where: "channel:ops", summary: "hello" });
  const r1 = await rev();
  assert.ok(r1 > r0);
  await sc(lm, "logmem_status", { now: { doing: "x" } });
  assert.ok((await rev()) > r1);
  const refusing = (...c) => (c[0] === "INCR" ? Promise.reject(new Error("403 not allowed")) : redis(...c));
  const lm2 = createLogmem({ redis: refusing, space: "madez", sessionId: "t", surface: "x", defaultAgent: "codex" });
  assert.equal((await sc(lm2, "logmem_note", { where: "channel:ops", summary: "still lands" })).ok, true);
});

test("pulse: sign-in, shown spaces only, returns the rev", async () => {
  const { redis, lm } = setup();
  await sc(lm, "logmem_note", { where: "channel:ops", summary: "hello" });
  const h = createHandler({ env: ENV, redis });
  assert.equal((await call(h, { url: "/api/work?op=pulse&space=madez" })).status, 401);
  assert.equal((await call(h, { url: "/api/work?op=pulse&space=other", headers: { cookie } })).status, 403);
  const p = await call(h, { url: "/api/work?op=pulse&space=madez", headers: { cookie } });
  assert.equal(p.status, 200);
  assert.ok(p.body.rev > 0);
});

test("needs: open tasks and decisions with job and plan; an answer removes it, a defer keeps it", async () => {
  const { redis, lm, store } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "Launch" });
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship", details: { plan: "launch" } });
  const t = await sc(lm, "logmem_handoff", { to: "human:admin", where: "job:ship", summary: "Set the env var", walkthrough: { ...WT, due: "2026-10-20" } });
  const q = await sc(lm, "logmem_ask", { question: "Deploy?", action: "vercel promote", where: "job:ship", reversible: true });
  const h = createHandler({ env: ENV, redis });
  let n = (await call(h, { url: "/api/work?op=needs&space=madez", headers: { cookie } })).body;
  assert.equal(n.count, 2);
  assert.deepEqual(n.items.map((i) => [i.type, i.job, i.plan]), [["task", "ship", "launch"], ["decision", "ship", "launch"]], "due date first");
  await writeDecision(store, q.trail, { verdict: "defer", by: "human:mikey", secret: SECRET });
  n = await needsView(store, redis, "madez", { secret: SECRET });
  assert.equal(n.items.find((i) => i.type === "decision").ask.deferred != null, true, "deferred stays, marked");
  await writeDecision(store, q.trail, { verdict: "approve", by: "human:mikey", secret: SECRET });
  n = await needsView(store, redis, "madez", { secret: SECRET });
  assert.deepEqual(n.items.map((i) => i.trail), [t.trail]);
});

test("nudge: intent header, a person's ping on the job and the agent, owner by default, mirrored", async () => {
  const { redis, lm } = setup();
  await sc(lm, "logmem_assign", { job: "ship", title: "Ship", owner: "codex" });
  const h = createHandler({ env: ENV, redis });
  assert.equal((await call(h, { method: "POST", url: "/api/work?op=nudge", body: { space: "madez", job: "ship" }, headers: { cookie } })).status, 403);
  assert.equal((await call(h, { method: "POST", url: "/api/work?op=nudge", body: { space: "madez", job: "nope" }, headers: W })).status, 404);
  const r = await call(h, { method: "POST", url: "/api/work?op=nudge", body: { space: "madez", job: "ship", note: "Any news?" }, headers: W });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, "codex");
  for (const key of ["lm:madez:job:ship:log", "lm:madez:agent:codex:log"]) {
    const e = (await logOf(redis, key)).find((x) => x.kind === "ping");
    assert.equal(e.by, "human:admin");
    assert.match(e.summary, /Any news\?/);
  }
  assert.ok((await logOf(redis, "acmi:madez:work:ship:timeline")).some((x) => x.kind === "ping" || /Nudge/.test(x.summary || "")), "mirrored to ACMI");
});

test("unblock: only external or no-reason blocks; decision, task and agent blocks are refused", async () => {
  const { redis, lm, store } = setup();
  const h = createHandler({ env: ENV, redis });
  const post = (body) => call(h, { method: "POST", url: "/api/work?op=unblock", body: { space: "madez", ...body }, headers: W });
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  assert.equal((await post({ job: "a", note: "go" })).status, 409, "not blocked");
  await sc(lm, "logmem_stage", { job: "a", stage: "blocked", blocked_on: { type: "external", note: "Vendor outage" } });
  assert.equal((await post({ job: "a" })).status, 400, "needs a note");
  const ok = await post({ job: "a", note: "Vendor is back" });
  assert.equal(ok.status, 200);
  assert.equal((await store.getNow("job", "a")).stage, "active");
  assert.ok((await logOf(redis, "lm:madez:job:a:log")).some((e) => e.by === "human:admin" && e.payload?.unblocked === true));
  await sc(lm, "logmem_assign", { job: "b", title: "B" });
  await sc(lm, "logmem_ask", { question: "Go?", action: "x", where: "job:b" });
  assert.match((await post({ job: "b", note: "go" })).body.error, /answer it/);
  await sc(lm, "logmem_assign", { job: "c", title: "C" });
  await sc(lm, "logmem_stage", { job: "c", stage: "blocked", blocked_on: { type: "agent", ref: "codex", note: "Review" } });
  assert.match((await post({ job: "c", note: "go" })).body.error, /nudge it/);
});

test("home: plans with percent and next milestone, blocked worst first, agents, and the needs count", async () => {
  const { redis, lm, store } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "LogMem launch" });
  await sc(lm, "logmem_assign", { job: "g2", title: "G2", details: { plan: "launch", milestone: true, date: "2026-10-23" } });
  await sc(lm, "logmem_assign", { job: "g1", title: "G1", details: { plan: "launch", milestone: true, date: "2026-10-16" } });
  await sc(lm, "logmem_stage", { job: "g1", stage: "done" });
  await sc(lm, "logmem_assign", { job: "a", title: "A", details: { plan: "launch" } });
  await sc(lm, "logmem_assign", { job: "b", title: "B", details: { plan: "launch" } });
  await sc(lm, "logmem_stage", { job: "a", stage: "done" });
  await sc(lm, "logmem_stage", { job: "b", stage: "blocked", blocked_on: { type: "external", note: "Vendor" } });
  await sc(lm, "logmem_assign", { job: "loose", title: "Loose" });
  await store.setNow("job", "loose", { stage: "blocked", blocked_on: null });
  await sc(lm, "logmem_assign", { job: "t", title: "T" });
  await sc(lm, "logmem_handoff", { to: "human:admin", where: "job:t", summary: "Check it", walkthrough: WT });
  const v = await homeView(store, redis, "madez", { secret: SECRET, person: "human:admin" });
  const launch = v.plans.find((p) => p.id === "launch");
  assert.equal(launch.title, "LogMem launch");
  assert.equal(launch.jobs, 2);
  assert.equal(launch.percent, 50);
  assert.equal(launch.next_milestone.id, "g2");
  assert.equal(v.plans.at(-1).id, "general", "general goes last");
  assert.deepEqual(v.blocked.map((b) => b.id).slice(0, 2), ["loose", "b"], "no reason first");
  assert.ok(v.agents.some((a) => a.id === "claude-code"));
  assert.equal(v.needs_count, (await needsView(store, redis, "madez", { secret: SECRET, person: "human:admin" })).count);
});

test("rewrites: the clean paths map to /api/work and /api/tasks to /api/blockers", () => {
  const rw = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).rewrites;
  const map = Object.fromEntries(rw.map((r) => [r.source, r.destination]));
  assert.equal(map["/api/pulse"], "/api/work?op=pulse");
  assert.equal(map["/api/needs"], "/api/work?op=needs");
  assert.equal(map["/api/nudge"], "/api/work?op=nudge");
  assert.equal(map["/api/unblock"], "/api/work?op=unblock");
  assert.equal(map["/api/tasks"], "/api/blockers");
});
