// Lanes (docs/superpowers/specs/2026-10-20-logmem-lanes-design.md): a lane is a plan with a
// status. Exactly one P0; others active or parked with a reason. Parked jobs wait on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { lanesView, homeView } from "../src/http/view.mjs";
import { mockRes, mockReq } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/work.mjs";

process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";
const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
function setup() {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "chief-of-staff", defaultAgent: "chief-of-staff" });
  return { redis, lm, store: createStore(redis, { space: "madez" }) };
}
const plans = async (lm) => Object.fromEntries((await sc(lm, "logmem_plan", {})).plans.map((p) => [p.id, p.lane?.status || null]));

test("lanes: exactly one P0; setting a new P0 moves the old one to active; parked needs a reason", async () => {
  const { lm, redis } = setup();
  for (const [id, title] of [["launch", "LogMem launch"], ["superbus", "OpenACP x Super Bus"], ["entry", "Entry"]]) await sc(lm, "logmem_plan", { action: "create", plan: id, title });
  assert.equal((await sc(lm, "logmem_plan", { action: "lane", plan: "launch", status: "p0", why: "Mikey Oct 19: One Lane" })).ok, true);
  assert.match((await sc(lm, "logmem_plan", { action: "lane", plan: "entry", status: "parked" })).error, /needs why/);
  await sc(lm, "logmem_plan", { action: "lane", plan: "entry", status: "parked", why: "LogMem replaced Entry", until: "after the beta" });
  const r = await sc(lm, "logmem_plan", { action: "lane", plan: "superbus", status: "p0", why: "test" });
  assert.deepEqual(r.demoted, ["launch"]);
  assert.deepEqual(await plans(lm), { entry: "parked", launch: "active", superbus: "p0" });
  const log = (await redis("ZRANGE", "lm:madez:channel:lanes:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(log.some((e) => /Lane superbus: P0.*launch moved to active/.test(e.summary)), "each change is on channel:lanes");
  assert.match((await sc(lm, "logmem_plan", { action: "lane", plan: "nope", status: "active" })).error, /no plan 'nope'/);
});

test("parked jobs: blocked on purpose, shown as parked, not as Blocked on Home", async () => {
  const { lm, store } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "launch", title: "LogMem launch" });
  await sc(lm, "logmem_plan", { action: "lane", plan: "launch", status: "p0" });
  await sc(lm, "logmem_assign", { job: "redis", title: "Customer Redis", details: { plan: "launch" } });
  await sc(lm, "logmem_assign", { job: "stuck", title: "Stuck thing", details: { plan: "launch" } });
  await sc(lm, "logmem_assign", { job: "moving", title: "Moving thing", details: { plan: "launch" } });
  const p = await sc(lm, "logmem_stage", { job: "redis", stage: "blocked", blocked_on: { type: "external", note: "Parked until G-12", parked: true, until: "G-12" } });
  assert.match(p.entry.summary, /^parked until G-12/);
  await sc(lm, "logmem_stage", { job: "stuck", stage: "blocked", blocked_on: { type: "agent", ref: "codex", note: "Review" } });
  await sc(lm, "logmem_stage", { job: "moving", stage: "active" });
  const home = await homeView(store, store.redis, "madez", { person: "human:admin" });
  assert.deepEqual(home.blocked.map((b) => b.id), ["stuck"], "parked is not Blocked");
  assert.equal(home.parked_count, 1);
  assert.equal(home.plans[0].lane.status, "p0");
  const { lanes, p0 } = await lanesView(store);
  assert.equal(p0, "launch");
  const l = lanes.find((x) => x.id === "launch");
  assert.deepEqual([l.active_count, l.blocked_count, l.parked_jobs.map((j) => j.id)], [1, 1, ["redis"]]);
  assert.equal(l.parked_jobs[0].blocked_on.until, "G-12");
});

test("lane API: a person sets lanes; intent header required; logged by the person", async () => {
  const { lm, redis } = setup();
  await sc(lm, "logmem_plan", { action: "create", plan: "entry", title: "Entry" });
  const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production", LOGMEM_VIEW_SPACES: "madez", LOGMEM_ADMIN_ID: "mikey" };
  const cookie = issueCookie(ENV).split(";")[0];
  const h = createHandler({ env: ENV, redis });
  const post = async (body, headers) => { const res = mockRes(); await h(mockReq({ method: "POST", url: "/api/work?op=lane", body: { space: "madez", ...body }, headers: { host: "logmem.si", cookie, ...headers } }), res); return { status: res.statusCode, body: JSON.parse(res.body) }; };
  assert.equal((await post({ plan: "entry", status: "parked", why: "x" }, {})).status, 403);
  const w = { "x-logmem-intent": "work", origin: "https://logmem.si" };
  assert.equal((await post({ plan: "entry", status: "parked" }, w)).status, 400);
  const ok = await post({ plan: "entry", status: "parked", why: "LogMem replaced Entry" }, w);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.plan.lane.set_by, "human:mikey");
  const log = (await redis("ZRANGE", "lm:madez:channel:lanes:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.equal(log.at(-1).by, "human:mikey");
});
