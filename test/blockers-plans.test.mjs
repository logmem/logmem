// Blockers (handoffs to a person, with walkthroughs) and Plans (jobs grouped by track).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { getBlocker, listBlockers, setStep, markDone, normalizeWalkthrough } from "../src/core/blockers.mjs";
import { planView } from "../src/http/view.mjs";
import { runCheck, DAY_MS } from "../scripts/dogfood-check.mjs";
import { mockRes, mockReq } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/blockers.mjs";

const WT = { steps: [{ title: "Open Vercel", detail: "Project logmem, Settings, Environment Variables." }, { title: "Tick Preview on CLERK_PUBLISHABLE_KEY", cmd: "open https://vercel.com" }], time: "2 min", place: "Vercel", done_when: "The key shows Preview.", reply: "[logmem @claude-code] Clerk key is in Preview." };
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis, space = "madez") => createLogmem({ redis, space, sessionId: "s", surface: "claude-code", defaultAgent: "claude-code" });

test("blockers: a handoff to a person writes the entry and a blocker with its walkthrough", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_assign", { job: "clerk-preview", title: "Clerk key in Preview" });
  const r = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:clerk-preview", summary: "Tick Preview on the Clerk publishable key", walkthrough: WT });
  assert.equal(r.ok, true);
  assert.equal(r.person, true);
  const log = (await redis("ZRANGE", "lm:madez:job:clerk-preview:log", "0", "-1")).map((x) => JSON.parse(x));
  const ho = log.find((e) => e.kind === "handoff");
  assert.equal(ho.to, "human:mikey");
  assert.equal(ho.payload.walkthrough.steps.length, 2);
  const store = createStore(redis, { space: "madez" });
  const b = await getBlocker(store, r.trail);
  assert.equal(b.by, "agent:claude-code");
  assert.equal(b.where, "job:clerk-preview");
  const brief = await sc(lm, "logmem_brief", {});
  assert.deepEqual(brief.person_blockers.map((x) => x.progress), ["0/2"]);
});

test("blockers: bad person ids, a missing where and oversized walkthroughs are refused", async () => {
  const lm = lmFor(createMemoryRedis());
  assert.match((await sc(lm, "logmem_handoff", { to: "human:Bad Id", where: "job:x", summary: "s" })).error, /human:<id>/);
  assert.match((await sc(lm, "logmem_handoff", { to: "human:mikey", summary: "s" })).error, /needs where/);
  assert.match((await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:x", summary: "s", walkthrough: { steps: Array(21).fill({ title: "t" }) } })).error, /at most 20 steps/);
  assert.match((await sc(lm, "logmem_handoff", { to: "atlas", summary: "s", walkthrough: WT, create_agent: true })).error, /only for handoffs to a person/);
  assert.throws(() => normalizeWalkthrough({ steps: [{ detail: "no title" }] }), /needs a title/);
});

test("blockers: only a person ticks steps or marks done; agents see progress in the Brief", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  const r = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:clerk-preview", summary: "Tick Preview", walkthrough: WT });
  const store = createStore(redis, { space: "madez" });
  await assert.rejects(() => setStep(store, r.trail, { step: 0, checked: true, by: "agent:claude-code" }), /only a person/);
  await setStep(store, r.trail, { step: 0, checked: true, by: "human:admin" });
  assert.deepEqual((await sc(lm, "logmem_brief", {})).person_blockers.map((x) => x.progress), ["1/2"]);
  await assert.rejects(() => setStep(store, r.trail, { step: 9, checked: true, by: "human:admin" }), /no such step/);
  await markDone(store, r.trail, { by: "human:admin", note: "done in 2 min" });
  assert.deepEqual(await listBlockers(store), []);
  assert.deepEqual((await sc(lm, "logmem_brief", {})).person_blockers, []);
  const log = (await redis("ZRANGE", "lm:madez:job:clerk-preview:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(log.some((e) => e.kind === "progress" && e.by === "human:admin" && e.origin === r.trail));
  assert.ok(log.some((e) => e.kind === "done" && e.by === "human:admin" && e.payload.note === "done in 2 min"));
});

test("blockers: the dogfood check does not count handoffs to people", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:clerk-preview", summary: "Tick Preview", walkthrough: WT });
  const { day } = await runCheck(redis, { space: "madez", mirrorSpaces: [], now: Date.now() + DAY_MS + 60_000 });
  assert.equal(day.handoffs, 0);
  assert.equal(day.unanswered_24h, 0, "a slow person never fails the agents' health check");
});

const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "madez", LOGMEM_MIRROR_ACMI: "1", LOGMEM_MIRROR_SPACES: "madez" };
const cookie = issueCookie(ENV).split(";")[0];
const call = async (h, { method = "GET", url = "/api/blockers?space=madez", body, headers = {} } = {}) => {
  const req = mockReq({ method, url, body, headers: { host: "logmem.si", ...headers } });
  const res = mockRes();
  await h(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

test("blockers API: admin only, intent header on writes, mirrored person entries", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  const r = await sc(lm, "logmem_handoff", { to: "human:mikey", where: "job:clerk-preview", summary: "Tick Preview", walkthrough: WT });
  const h = createHandler({ env: ENV, redis });
  assert.equal((await call(h)).status, 401);
  const list = await call(h, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.body.blockers.length, 1);
  assert.deepEqual(list.body.spaces, ["madez"]);
  assert.equal((await call(h, { method: "POST", body: { space: "madez", trail: r.trail, action: "step", step: 0, checked: true }, headers: { cookie } })).status, 403);
  const w = { cookie, "x-logmem-intent": "blockers", origin: "https://logmem.si" };
  assert.equal((await call(h, { method: "POST", body: { space: "madez", trail: r.trail, action: "step", step: 0, checked: true }, headers: w })).body.blocker.steps_done[0], 0);
  assert.equal((await call(h, { method: "POST", body: { space: "madez", trail: r.trail, action: "done" }, headers: w })).body.blocker.done, true);
  const twins = (await redis("ZRANGE", "acmi:madez:work:clerk-preview:timeline", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(twins.some((t) => String(t.source || t.by || "").includes("admin")), "person entries are mirrored to ACMI");
  assert.equal((await call(h, { method: "POST", body: { space: "other", trail: r.trail, action: "done" }, headers: w })).status, 403);
});

test("plans: jobs group by track with milestones and percentages", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis);
  await sc(lm, "logmem_assign", { job: "g2", title: "G2: copies match", details: { plan: "launch", milestone: true, date: "2026-10-23", criteria: "Copies match, no secrets" } });
  await sc(lm, "logmem_assign", { job: "g1", title: "G1: name cleared", details: { plan: "launch", milestone: true, date: "2026-10-16", criteria: "Name and handles" } });
  await sc(lm, "logmem_assign", { job: "jail", title: "Customer Redis jail", details: { plan: "launch", track: "Build", gate: "G2" } });
  await sc(lm, "logmem_assign", { job: "limits", title: "Free limits", details: { plan: "launch", track: "Build", gate: "G2" } });
  await sc(lm, "logmem_assign", { job: "readme", title: "README", details: { plan: "launch", track: "Launch", due: "2026-10-30" } });
  await sc(lm, "logmem_assign", { job: "other", title: "Not in a plan" });
  await sc(lm, "logmem_stage", { job: "jail", stage: "done" });
  const v = await planView(createStore(redis, { space: "madez" }), "launch");
  assert.deepEqual(v.plans, ["launch"]);
  assert.deepEqual(v.milestones.map((m) => m.id), ["g1", "g2"], "milestones sorted by date");
  const build = v.tracks.find((t) => t.title === "Build");
  assert.equal(build.items.length, 2);
  assert.equal(build.percent, 50);
  assert.equal(v.percent, 33);
  assert.ok(!JSON.stringify(v).includes("Not in a plan"));
  assert.equal((await planView(createStore(createMemoryRedis(), { space: "madez" }), "")).plan, null);
});
