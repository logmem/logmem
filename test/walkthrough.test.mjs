// Walkthroughs written in the web app: one admin save (write), the existing tick, the player read.
// Spec: docs/superpowers/specs/2026-10-20-logmem-walkthrough-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { getBlocker, setStep, markDone, writeWalkthrough, WRITER_STEPS } from "../src/core/blockers.mjs";
import { mockRes, mockReq } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/blockers.mjs";

const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis) => createLogmem({ redis, space: "madez", sessionId: "s", surface: "claude-code", defaultAgent: "claude-code" });
const W = { steps: [
  { title: "Open Infisical", go: "https://app.infisical.com", see: "The logmem project" },
  { title: "Add NPM_TOKEN under prod", detail: "Name it NPM_TOKEN.", see: "NPM_TOKEN in the list" },
], done_when: "NPM_TOKEN shows in prod", reply: "Done: NPM_TOKEN is in Infisical." };
const setup = async () => {
  const redis = createMemoryRedis();
  await sc(lmFor(redis), "logmem_assign", { job: "npm-publish", title: "Publish @logmem/mcp" });
  return { redis, store: createStore(redis, { space: "madez" }) };
};
const fixed = (t) => () => t;

test("walkthrough: a person writes one on a job; it is a task with a handoff entry and the job waits on it", async () => {
  const { redis, store } = await setup();
  const b = await writeWalkthrough(store, { job: "npm-publish", to: "human:mikey", summary: "Put the npm token in Infisical", walkthrough: W, by: "human:mikey", now: fixed(1000), mint: () => "wt-1" });
  assert.equal(b.trail, "wt-1");
  assert.equal(b.by, "human:mikey");
  assert.equal(b.where, "job:npm-publish");
  assert.deepEqual(b.walkthrough.steps.map((s) => [s.go, s.see]), [["https://app.infisical.com", "The logmem project"], [undefined, "NPM_TOKEN in the list"]]);
  const log = (await redis("ZRANGE", "lm:madez:job:npm-publish:log", "0", "-1")).map((x) => JSON.parse(x));
  const ho = log.find((e) => e.kind === "handoff");
  assert.equal(ho.by, "human:mikey");
  assert.equal(ho.to, "human:mikey");
  assert.equal(ho.trail, "wt-1");
  const now = await store.getNow("job", "npm-publish");
  assert.equal(now.stage, "blocked");
  assert.deepEqual(now.blocked_on, { type: "task", ref: "wt-1", note: "Put the npm token in Infisical" });
  // The person follows it with the existing tick, and the last screen's reply closes it and the link.
  await setStep(store, "wt-1", { step: 0, checked: true, by: "human:mikey", now: fixed(2000) });
  await setStep(store, "wt-1", { step: 1, checked: true, by: "human:mikey", now: fixed(3000) });
  const done = await markDone(store, "wt-1", { by: "human:mikey", note: "Done: NPM_TOKEN is in Infisical.", now: fixed(4000) });
  assert.equal(done.note, "Done: NPM_TOKEN is in Infisical.");
  assert.notEqual((await store.getNow("job", "npm-publish")).stage, "blocked");
});

test("walkthrough: at most 7 steps, a title, a person, an existing job", async () => {
  const { store } = await setup();
  const base = { job: "npm-publish", to: "human:mikey", summary: "t", by: "human:mikey" };
  await assert.rejects(() => writeWalkthrough(store, { ...base, walkthrough: { steps: Array(WRITER_STEPS + 1).fill({ title: "x" }) } }), /at most 7 steps/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, walkthrough: { steps: [] } }), /at least one step/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, summary: " ", walkthrough: W }), /title/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, to: "atlas", walkthrough: W }), /human:<id>/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, by: "agent:claude-code", walkthrough: W }), /signed-in person/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, job: "nope", walkthrough: W }), /does not exist/);
  await assert.rejects(() => writeWalkthrough(store, { ...base, walkthrough: { steps: [{ title: "x", see: "y".repeat(301) }] } }), /longer than 300/);
});

test("walkthrough: secret-shaped values are refused; naming the vault entry is fine", async () => {
  const { store } = await setup();
  const base = { job: "npm-publish", to: "human:mikey", summary: "t", by: "human:mikey" };
  const values = [
    "npm_token=npm_abcdefgh12345678",
    "sk-proj-abcdefghijklmnop1234",
    "export GITHUB_TOKEN ghp_abcdefghijklmnop1234",
    "Authorization: Bearer abcdefghijklmnop1234",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "AKIAABCDEFGHIJKLMNOP",
    "Zq7".repeat(15),
  ];
  for (const v of values) {
    await assert.rejects(() => writeWalkthrough(store, { ...base, walkthrough: { steps: [{ title: "Paste it", cmd: v }] } }), /secret value/, v);
  }
  await assert.rejects(() => writeWalkthrough(store, { ...base, summary: "use sk-live-abcdefghijklmnop12", walkthrough: W }), /secret value/);
  const ok = await writeWalkthrough(store, { ...base, walkthrough: { steps: [{ title: "Copy the npm token from the Infisical entry 'npm publish'", cmd: "git rev-parse 3f9c2a1b8e7d6c5b4a39281706f5e4d3c2b1a090" }] }, mint: () => "wt-ok" });
  assert.equal(ok.trail, "wt-ok");
});

test("walkthrough: the writer edits it until the first tick, and only the writer", async () => {
  const { store } = await setup();
  await writeWalkthrough(store, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-2" });
  const v2 = await writeWalkthrough(store, { trail: "wt-2", to: "human:avery", summary: "v2", walkthrough: { steps: [{ title: "Only step" }] }, by: "human:mikey" });
  assert.equal(v2.summary, "v2");
  assert.equal(v2.to, "human:avery");
  assert.equal(v2.walkthrough.steps.length, 1);
  await assert.rejects(() => writeWalkthrough(store, { trail: "wt-2", to: "human:mikey", summary: "x", walkthrough: W, by: "human:avery" }), /only the person who wrote/);
  await setStep(store, "wt-2", { step: 0, checked: true, by: "human:avery" });
  await assert.rejects(() => writeWalkthrough(store, { trail: "wt-2", to: "human:mikey", summary: "v3", walkthrough: W, by: "human:mikey" }), /started this walkthrough/);
  assert.equal((await getBlocker(store, "wt-2")).summary, "v2");
});

const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "madez", LOGMEM_ADMIN_ID: "mikey" };
const cookie = issueCookie(ENV).split(";")[0];
const call = async (h, { method = "GET", url = "/api/blockers?space=madez", body, headers = {} } = {}) => {
  const req = mockReq({ method, url, body, headers: { host: "logmem.si", ...headers } });
  const res = mockRes();
  await h(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

test("walkthrough API: write needs the intent header; the player reads one task, open or closed", async () => {
  const { redis } = await setup();
  const h = createHandler({ env: ENV, redis });
  const w = { cookie, "x-logmem-intent": "blockers", origin: "https://logmem.si" };
  const body = { space: "madez", action: "write", job: "npm-publish", summary: "Put the npm token in Infisical", walkthrough: W };
  assert.equal((await call(h, { method: "POST", body })).status, 401);
  assert.equal((await call(h, { method: "POST", body, headers: { cookie } })).status, 403);
  const r = await call(h, { method: "POST", body, headers: w });
  assert.equal(r.status, 200);
  const trail = r.body.blocker.trail;
  assert.match(trail, /^walkthrough-npm-publish-\d+-[0-9a-f]{12}$/);
  assert.equal(r.body.blocker.to, "human:mikey"); // defaults to the signed-in person
  const one = await call(h, { url: `/api/blockers?space=madez&trail=${trail}`, headers: { cookie } });
  assert.equal(one.status, 200);
  assert.equal(one.body.blocker.walkthrough.steps.length, 2);
  await call(h, { method: "POST", body: { space: "madez", action: "done", trail, note: "ok" }, headers: w });
  const closed = await call(h, { url: `/api/blockers?space=madez&trail=${trail}`, headers: { cookie } });
  assert.equal(closed.body.blocker.done, true);
  assert.equal((await call(h, { url: "/api/blockers?space=madez&trail=nope", headers: { cookie } })).status, 404);
  const bad = await call(h, { method: "POST", body: { ...body, walkthrough: { steps: [{ title: "x", cmd: "sk-proj-abcdefghijklmnop1234" }] } }, headers: w });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /secret value/);
});

test("walkthrough API: someone else's task is not readable by another person", async () => {
  const { redis, store } = await setup();
  await writeWalkthrough(store, { job: "npm-publish", to: "human:avery", summary: "Avery's", walkthrough: W, by: "human:avery", mint: () => "wt-avery" });
  const h = createHandler({ env: ENV, redis });
  assert.equal((await call(h, { url: "/api/blockers?space=madez&trail=wt-avery", headers: { cookie } })).status, 404);
});

test("walkthrough player: links are http(s) only, and nothing writes raw HTML", () => {
  const src = readFileSync(new URL("../public/app/walk.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|unsafeHTML|document\.write/);
  assert.match(src, /u\.protocol === 'https:' \|\| u\.protocol === 'http:'/);
  assert.match(src, /rel="noopener noreferrer"/);
});

// ─── codex review of PR 88 at 7ea5584 ───────────────────────────────
// A Redis wrapper that runs `between()` once, right before the next EVAL (the compare-and-set),
// so another write lands between a read and its write.
function racing(base) {
  let between = null;
  const redis = async (cmd, ...args) => {
    if (cmd === "EVAL" && between) { const h = between; between = null; await h(); }
    return base(cmd, ...args);
  };
  return { redis, before: (fn) => { between = fn; } };
}
const raceSetup = async () => {
  const base = createMemoryRedis();
  await sc(lmFor(base), "logmem_assign", { job: "npm-publish", title: "Publish @logmem/mcp" });
  const r = racing(base);
  return { other: createStore(base, { space: "madez" }), store: createStore(r.redis, { space: "madez" }), before: r.before };
};

test("PR 88 finding 1: unticking every step does not unlock editing", async () => {
  const { store } = await setup();
  await writeWalkthrough(store, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-u" });
  await setStep(store, "wt-u", { step: 0, checked: true, by: "human:mikey" });
  await setStep(store, "wt-u", { step: 0, checked: false, by: "human:mikey" });
  const rec = await getBlocker(store, "wt-u");
  assert.deepEqual(rec.steps_done, []);
  assert.ok(rec.started_at, "the started marker stays after unticking");
  await assert.rejects(() => writeWalkthrough(store, { trail: "wt-u", to: "human:mikey", summary: "v2", walkthrough: W, by: "human:mikey" }), /started this walkthrough/);
  assert.equal((await getBlocker(store, "wt-u")).summary, "v1");
});

test("PR 88 finding 2: an edit never erases a tick that lands while it is in flight", async () => {
  const { store, other, before } = await raceSetup();
  await writeWalkthrough(other, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-r" });
  before(() => setStep(other, "wt-r", { step: 1, checked: true, by: "human:mikey" }));
  await assert.rejects(() => writeWalkthrough(store, { trail: "wt-r", to: "human:mikey", summary: "v2", walkthrough: { steps: [{ title: "x" }] }, by: "human:mikey" }), /changed while you were editing/);
  const rec = await getBlocker(other, "wt-r");
  assert.deepEqual(rec.steps_done, [1]);
  assert.equal(rec.summary, "v1");
});

test("PR 88 finding 2: an edit never reopens a task closed while it is in flight", async () => {
  const { store, other, before } = await raceSetup();
  await writeWalkthrough(other, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-c" });
  before(() => markDone(other, "wt-c", { by: "human:mikey", note: "done" }));
  await assert.rejects(() => writeWalkthrough(store, { trail: "wt-c", to: "human:mikey", summary: "v2", walkthrough: W, by: "human:mikey" }), /changed while you were editing/);
  assert.equal((await getBlocker(other, "wt-c")).done, true);
});

test("PR 88 finding 2: two ticks at once both stay (the second retries)", async () => {
  const { store, other, before } = await raceSetup();
  await writeWalkthrough(other, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-t" });
  before(() => setStep(other, "wt-t", { step: 1, checked: true, by: "human:mikey" }));
  await setStep(store, "wt-t", { step: 0, checked: true, by: "human:mikey" });
  assert.deepEqual((await getBlocker(other, "wt-t")).steps_done, [0, 1]);
});

test("PR 88 finding 3: writer drafts are keyed by space and save to their own space", () => {
  const src = readFileSync(new URL("../public/app/walk.js", import.meta.url), "utf8");
  assert.match(src, /const draftKey = \(space, job, trail\) =>/);
  assert.match(src, /if \(d\.space !== state\.space\)/);
  assert.match(src, /postJSON\('\/api\/tasks', 'blockers', \{ space: d\.space, action: 'write'/);
});

// ─── codex review of PR 88 at 5bcd83c ───────────────────────────────
test("PR 88 re-review 1: a tick that loses to an edit never ticks the new instructions", async () => {
  const { store, other, before } = await raceSetup();
  const b = await writeWalkthrough(other, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-rev" });
  assert.equal(b.rev, 1);
  // The edit lands between the tick's read and its write.
  before(() => writeWalkthrough(other, { trail: "wt-rev", to: "human:mikey", summary: "v2", walkthrough: { steps: [{ title: "New step one" }, { title: "New step two" }] }, by: "human:mikey" }));
  await assert.rejects(() => setStep(store, "wt-rev", { step: 0, checked: true, by: "human:mikey" }), /walkthrough changed/);
  const rec = await getBlocker(other, "wt-rev");
  assert.equal(rec.rev, 2);
  assert.deepEqual(rec.steps_done, []);
  assert.equal(rec.started_at, undefined);
});

test("PR 88 re-review 1: a tick for the revision the player showed is refused after an edit", async () => {
  const { store } = await setup();
  await writeWalkthrough(store, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-rev2" });
  await writeWalkthrough(store, { trail: "wt-rev2", to: "human:mikey", summary: "v2", walkthrough: W, by: "human:mikey" });
  await assert.rejects(() => setStep(store, "wt-rev2", { step: 0, checked: true, rev: 1, by: "human:mikey" }), /walkthrough changed/);
  const ok = await setStep(store, "wt-rev2", { step: 0, checked: true, rev: 2, by: "human:mikey" });
  assert.deepEqual(ok.steps_done, [0]);
});

test("PR 88 re-review 1: the tasks API passes the revision through", async () => {
  const { redis, store } = await setup();
  await writeWalkthrough(store, { job: "npm-publish", to: "human:mikey", summary: "v1", walkthrough: W, by: "human:mikey", mint: () => "wt-api" });
  await writeWalkthrough(store, { trail: "wt-api", to: "human:mikey", summary: "v2", walkthrough: W, by: "human:mikey" });
  const h = createHandler({ env: ENV, redis });
  const w = { cookie, "x-logmem-intent": "blockers", origin: "https://logmem.si" };
  const stale = await call(h, { method: "POST", body: { space: "madez", action: "step", trail: "wt-api", step: 0, checked: true, rev: 1 }, headers: w });
  assert.equal(stale.status, 400);
  assert.match(stale.body.error, /walkthrough changed/);
  assert.equal((await call(h, { method: "POST", body: { space: "madez", action: "step", trail: "wt-api", step: 0, checked: true, rev: 2 }, headers: w })).status, 200);
});

test("PR 88 re-review 2: player state is keyed by space and trail, and its writes go to that space", () => {
  const src = readFileSync(new URL("../public/app/walk.js", import.meta.url), "utf8");
  assert.match(src, /const playKey = \(space, trail\) =>/);
  assert.doesNotMatch(src, /play\.key !== rec\.trail/);
  // Every player write object (step, done, can't do) names the player's own space first.
  const writes = src.match(/\{ [^{}]*action: '(step|done|cant_do)'/g) || [];
  assert.equal(writes.length, 4, writes.join("\n"));
  for (const w of writes) assert.match(w, /^\{ space: play\.space, action:/, w);
  assert.match(src, /rev: rec\.rev \|\| 0/);
});

// ─── codex review of PR 88 at baf4c71: a slow reply for an older page is dropped ───
import vm from "node:vm";
function loadWalk(getJSON) {
  let src = readFileSync(new URL("../public/app/walk.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/export /g, "");
  src += "\ndrawPlayer = (rec) => { this.shown = rec.summary }; drawWriter = () => { this.drafted = draft && draft.key }; this.api = { playerPage, writerPage, getPlay: () => play, getDraft: () => draft };";
  const state = { space: "space-a" };
  const ctx = { URL, URLSearchParams, state, drawerOpen: () => false, closeDrawer: () => {}, okHook: () => true, getJSON, location: { replace() {} }, blankStep: undefined };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
const held = () => {
  const waiting = {};
  const getJSON = (url) => {
    const sp = new URL("https://x.test" + url).searchParams.get("space");
    return new Promise((resolve) => { (waiting[sp] = waiting[sp] || []).push(() => resolve({ __status: 200, who: { title: "Job in " + sp }, person: "human:admin", blocker: { trail: "same-task", rev: 1, summary: "Instructions from " + sp, to: "human:admin", by: "human:admin", walkthrough: { steps: [{ title: "One" }] }, steps_done: [] } })); });
  };
  const release = async (sp) => { for (const f of waiting[sp] || []) f(); waiting[sp] = []; await new Promise((r) => setTimeout(r, 0)); };
  return { getJSON, release };
};

test("PR 88 re-review 3: a slow player reply for space A never shows over space B", { timeout: 3000 }, async () => {
  const h = held();
  const ctx = loadWalk(h.getJSON);
  const a = ctx.api.playerPage("space-a/same-task");
  const b = ctx.api.playerPage("space-b/same-task");
  await h.release("space-b"); await b;
  await h.release("space-a"); await a;
  assert.equal(ctx.shown, "Instructions from space-b");
  assert.equal(ctx.api.getPlay().space, "space-b");
  assert.equal(ctx.api.getPlay().key, "space-b/same-task");
});

test("PR 88 re-review 3: a slow writer reply for an older job is dropped", { timeout: 3000 }, async () => {
  const h = held();
  const ctx = loadWalk(h.getJSON);
  const a = ctx.api.writerPage("job-a/same-task");
  ctx.state.space = "space-b";
  const b = ctx.api.writerPage("job-b/same-task");
  await h.release("space-b"); await h.release("space-b"); await b;
  await h.release("space-a"); await h.release("space-a"); await a;
  assert.equal(ctx.api.getDraft().key, "space-b/job-b/same-task");
  assert.equal(ctx.api.getDraft().space, "space-b");
});
