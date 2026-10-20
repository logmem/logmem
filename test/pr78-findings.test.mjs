// Codex's five P2 findings on PR 78 (job review-pr78), one regression test each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore, revKey } from "../src/core/store.mjs";
import { lmDecisionKey } from "../src/core/keys.mjs";
import { unblock } from "../src/http/work.mjs";
import { needsView } from "../src/http/view.mjs";
import { createPlan } from "../src/core/plans.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";
const SECRET = process.env.LOGMEM_DECIDE_SECRET;
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
function setup() {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "claude-code", defaultAgent: "claude-code" });
  return { redis, lm, store: createStore(redis, { space: "madez" }) };
}
const external = (lm, job) => sc(lm, "logmem_stage", { job, stage: "blocked", blocked_on: { type: "external", note: "Vendor outage" } });

test("finding 1: Unblock refuses a job with an open decision, even when blocked_on says external", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  await external(lm, "a");
  // A decision lands, then something (a stale writer) resets blocked_on to the old external reason.
  const q = await sc(lm, "logmem_ask", { question: "Go?", action: "x", where: "job:a" });
  await store.setNow("job", "a", { blocked_on: { type: "external", note: "Vendor outage" } });
  await assert.rejects(() => unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" }), (e) => e.status === 409 && /waits on a decision/.test(e.message));
  const now = await store.getNow("job", "a");
  assert.equal(now.stage, "blocked");
  assert.equal(now.waits[0].ref, q.trail);
});

// Codex re-review of PR 85: Unblock is one conditional transition; nothing is ever restored.
const unblockEntries = async (store, job) => (await store.readLog("job", job)).filter((e) => e.payload?.unblocked === true);

test("re-review (a): an agent blocker that lands during the write is kept, and Unblock refuses", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  await external(lm, "a");
  const real = store.redis;
  store.redis = async (...cmd) => {
    if (cmd[0] === "EVAL") {
      store.redis = real;
      await sc(lm, "logmem_stage", { job: "a", stage: "blocked", blocked_on: { type: "agent", ref: "codex", note: "Review" } });
    }
    return real(...cmd);
  };
  await assert.rejects(() => unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" }), (e) => e.status === 409 && /changed while you were unblocking|now waits on/.test(e.message));
  const now = await store.getNow("job", "a");
  assert.equal(now.stage, "blocked");
  assert.equal(now.blocked_on.type, "agent", "the newer blocker survives");
  assert.equal((await unblockEntries(store, "a")).length, 0);
});

test("re-review (b): a failure right after the state write is finished by a retry, with one entry", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  await external(lm, "a");
  const realTouch = store.touchNow.bind(store);
  store.touchNow = async () => { store.touchNow = realTouch; throw new Error("index down"); };
  await assert.rejects(() => unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" }), /index down/);
  assert.equal((await store.getNow("job", "a")).stage, "active", "the transition itself landed");
  const again = await unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  const third = await unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" });
  assert.equal(third.replayed, true);
  assert.equal((await unblockEntries(store, "a")).length, 1, "the entry is written once");
  await assert.rejects(() => unblock(store, { job: "a", note: "another reason", by: "human:mikey" }), (e) => e.status === 409);
});

test("re-review (c): a job marked done while the entry write fails stays done; nothing is restored", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  await external(lm, "a");
  const realAppend = store.append.bind(store);
  store.append = async () => {
    store.append = realAppend;
    await store.setNow("job", "a", { stage: "done", stage_at: Date.now() + 1 });
    throw new Error("bridge down");
  };
  await assert.rejects(() => unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" }), /bridge down/);
  assert.equal((await store.getNow("job", "a")).stage, "done", "the newer done stands");
  const retry = await unblock(store, { job: "a", note: "vendor is back", by: "human:mikey" });
  assert.equal(retry.replayed, true);
  assert.equal(retry.now.stage, "done");
  assert.equal((await unblockEntries(store, "a")).length, 1);
});

test("finding 3: a junk or old-key decision claim does not hide a pending ask", async () => {
  const { lm, store, redis } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  const q = await sc(lm, "logmem_ask", { question: "Go?", action: "x", where: "job:a" });
  await redis("SET", lmDecisionKey("madez", q.trail), JSON.stringify({ v: 3, kind: "decided", origin: q.trail, payload: { verdict: "approve", sig: "0".repeat(64) }, by: "human:mikey" }));
  const n = await needsView(store, redis, "madez", { secret: SECRET, person: "human:admin" });
  assert.ok(n.items.some((i) => i.trail === q.trail), "an unverified claim leaves the ask open");
});

test("finding 4: a named person's Needs shows only asks for them or for anyone", async () => {
  const { lm, store, redis } = setup();
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  const forMikey = await sc(lm, "logmem_ask", { question: "Rotate?", action: "x", where: "job:a", to: "human:mikey" });
  const forAvery = await sc(lm, "logmem_ask", { question: "Build?", action: "y", where: "job:a", to: "human:avery" });
  const anyone = await sc(lm, "logmem_ask", { question: "Ship?", action: "z", where: "job:a" });
  const trails = async (person) => (await needsView(store, redis, "madez", { secret: SECRET, person })).items.map((i) => i.trail).sort();
  assert.deepEqual(await trails("human:mikey"), [anyone.trail, forMikey.trail].sort());
  assert.deepEqual(await trails("human:avery"), [anyone.trail, forAvery.trail].sort());
});

test("finding 5: plan writes and Who, Now and Log deletions bump the pulse revision", async () => {
  const { lm, store, redis } = setup();
  const rev = async () => Number((await redis("GET", revKey("madez"))) || 0);
  let r = await rev();
  await createPlan(store, { id: "launch", title: "Launch" });
  assert.ok((await rev()) > r, "plan creation");
  r = await rev();
  await sc(lm, "logmem_plan", { action: "lane", plan: "launch", status: "p0" });
  assert.ok((await rev()) > r, "lane change");
  await sc(lm, "logmem_assign", { job: "a", title: "A" });
  r = await rev();
  await store.deleteNow("job", "a", "stage");
  assert.ok((await rev()) > r, "Now field deletion");
  r = await rev();
  await store.deleteWho("job", "a");
  assert.ok((await rev()) > r, "Who deletion");
  const entry = (await store.readLog("job", "a", { limit: 1 }))[0];
  r = await rev();
  assert.equal(await store.removeEntry("job", "a", entry), 1);
  assert.ok((await rev()) > r, "Log entry removal");
});
