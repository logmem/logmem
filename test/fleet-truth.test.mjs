import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeFact,
  buildSummary,
  scrubSecrets,
  emptyBoard,
} from "../src/fleet-truth/schema.mjs";
import { slotFor, trailId, etDate } from "../src/fleet-truth/slot.mjs";

test("makeFact requires claim status observed_at source and accepts verified_by", () => {
  const f = makeFact({
    claim: "bridge up",
    status: "verified",
    observed_at: "2026-11-04T14:00:00.000Z",
    source: "probe:bridge",
    verified_by: "probe:bridge",
  });
  assert.equal(f.claim, "bridge up");
  assert.equal(f.status, "verified");
  assert.equal(f.observed_at, "2026-11-04T14:00:00.000Z");
  assert.equal(f.source, "probe:bridge");
  assert.equal(f.verified_by, "probe:bridge");
  assert.throws(() => makeFact({ claim: "x", status: "verified", observed_at: "t" }), /source/);
  assert.throws(() => makeFact({ claim: "x", status: "nope", observed_at: "t", source: "s" }), /status/);
});

test("buildSummary stays under 200 chars and includes the four fields", () => {
  const s = buildSummary({
    refreshed_at: "2026-11-04T18:00:00.000Z",
    slot: "midday",
    p0: "launch",
    top_blocker: "Mikey Cursor GitHub-app gate",
    infra: "ok",
  });
  assert.ok(s.length < 200, s.length);
  assert.match(s, /midday/);
  assert.match(s, /launch/);
  assert.match(s, /Mikey Cursor GitHub-app gate/);
  assert.match(s, /\binfra=ok\b/);
  assert.match(s, /fleet-truth/);
});

test("scrubSecrets redacts Bearer tokens, sk- keys, and emails in nested objects", () => {
  const cleaned = scrubSecrets({
    claim: "Authorization: Bearer abcdefghijklmnop",
    nested: { note: "key sk-abcdefghijklmnopqrstuvwxyz012345", mail: "ops@example.com" },
    list: ["ok", "Bearer zzzzzzzzzzzzzzzz"],
  });
  const json = JSON.stringify(cleaned);
  assert.equal(json.includes("abcdefghijklmnop"), false);
  assert.equal(json.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(json.includes("ops@example.com"), false);
  assert.match(json, /\[REDACTED\]/);
});

test("slotFor returns morning midday closeout at ET hours and null otherwise", () => {
  // 2026-11-04 is EST (UTC-5; DST ended Nov 1): 09/13/17 ET = 14/18/22 UTC
  const morning = Date.parse("2026-11-04T14:00:00.000Z");
  const midday = Date.parse("2026-11-04T18:00:00.000Z");
  const closeout = Date.parse("2026-11-04T22:00:00.000Z");
  const ten = Date.parse("2026-11-04T15:00:00.000Z"); // 10:00 ET
  assert.equal(slotFor(morning), "morning");
  assert.equal(slotFor(midday), "midday");
  assert.equal(slotFor(closeout), "closeout");
  assert.equal(slotFor(ten), null);
});

test("trailId and etDate format ET calendar date", () => {
  assert.equal(trailId("2026-11-04", "midday"), "fleetTruth-20261104-midday");
  assert.equal(etDate(Date.parse("2026-11-04T14:00:00.000Z")), "2026-11-04");
});

test("emptyBoard has schema v1 and required section keys", () => {
  const b = emptyBoard({
    refreshed_at: "2026-11-04T18:00:00.000Z",
    slot: "midday",
    runner: "agent:fleet-truth",
    trail: "fleetTruth-20261104-midday",
  });
  assert.equal(b.schema, "fleet-truth/v1");
  assert.equal(b.slot, "midday");
  assert.equal(b.runner, "agent:fleet-truth");
  for (const k of ["clock", "lanes", "launch", "blockers", "infra", "agents", "deltas"]) {
    assert.ok(Array.isArray(b[k].items), k);
  }
});

import { buildBoard, FRESHNESS_MS } from "../src/fleet-truth/build.mjs";
import { CORE_AGENTS, defaultClockClaims } from "../src/fleet-truth/core.mjs";

const iso = (ms) => new Date(ms).toISOString();
const T = Date.parse("2026-11-04T18:00:00.000Z");

test("buildBoard keeps verified observation with verified_by", () => {
  const { now } = buildBoard({
    observations: [{
      section: "infra",
      fact: makeFact({
        claim: "bridge up",
        status: "verified",
        observed_at: iso(T),
        source: "probe:bridge",
        verified_by: "probe:bridge",
      }),
    }],
    previous: null,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  assert.equal(now.infra.items[0].status, "verified");
  assert.equal(now.infra.items[0].verified_by, "probe:bridge");
});

test("buildBoard keeps recent reported previous fact and stales old ones", () => {
  const recent = makeFact({
    claim: "Show HN Wed Nov 18 2026 9:30 ET",
    status: "reported",
    observed_at: iso(T - 2 * 3600e3),
    source: "memo:fleet",
  });
  const old = makeFact({
    claim: "old rumor",
    status: "reported",
    observed_at: iso(T - FRESHNESS_MS - 1000),
    source: "memo:old",
  });
  const prev = emptyBoard({ refreshed_at: iso(T - 3600e3), slot: "morning", runner: "agent:fleet-truth", trail: "fleetTruth-20261104-morning" });
  prev.clock.items = [recent, old];
  const { now } = buildBoard({ observations: [], previous: prev, nowMs: T, slot: "midday", runner: "agent:fleet-truth" });
  const byClaim = Object.fromEntries(now.clock.items.map((f) => [f.claim, f]));
  assert.equal(byClaim[recent.claim].status, "reported");
  assert.equal(byClaim[old.claim].status, "stale");
});

test("buildBoard never upgrades reported clock to verified without observation", () => {
  const prev = emptyBoard({ refreshed_at: iso(T - 1000), slot: "morning", runner: "agent:fleet-truth", trail: "t" });
  prev.clock.items = [makeFact({ claim: "Show HN seed", status: "reported", observed_at: iso(T - 1000), source: "core:show-hn-seed" })];
  const { now } = buildBoard({ observations: [], previous: prev, nowMs: T, slot: "midday", runner: "agent:fleet-truth" });
  assert.equal(now.clock.items.find((f) => f.claim === "Show HN seed").status, "reported");
});

test("buildBoard drops previous lanes without a fresh observation (snapshot section)", () => {
  const prev = emptyBoard({ refreshed_at: iso(T - 1000), slot: "morning", runner: "agent:fleet-truth", trail: "t" });
  prev.lanes.items = [makeFact({ claim: "P0=launch", status: "reported", observed_at: iso(T - 1000), source: "job:x" })];
  const { now } = buildBoard({ observations: [], previous: prev, nowMs: T, slot: "midday", runner: "agent:fleet-truth" });
  assert.equal(now.lanes.items.length, 0);
});

test("buildBoard deltas note changes and no material change when identical", () => {
  const fact = makeFact({ claim: "bridge up", status: "verified", observed_at: iso(T), source: "probe:bridge", verified_by: "probe:bridge" });
  const first = buildBoard({
    observations: [{ section: "infra", fact }],
    previous: null,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  assert.ok(first.now.deltas.items.some((d) => d.claim.includes("bridge up")));
  const second = buildBoard({
    observations: [{ section: "infra", fact: { ...fact, observed_at: iso(T + 1) } }],
    previous: first.now,
    nowMs: T + 1,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  // same claim+status → no material change
  assert.equal(second.now.deltas.items.length, 1);
  assert.equal(second.now.deltas.items[0].claim, "no material change");
  assert.equal(second.now.deltas.items[0].status, "verified");
});

test("buildBoard summary uses P0 top blocker and infra rollup", () => {
  const { summary } = buildBoard({
    observations: [
      { section: "lanes", fact: makeFact({ claim: "P0=launch owner=hermes", status: "verified", observed_at: iso(T), source: "plan:launch", verified_by: "agent:fleet-truth" }) },
      { section: "blockers", fact: makeFact({ claim: "Cursor GitHub-app gate", status: "verified", observed_at: iso(T), source: "job:x", verified_by: "agent:fleet-truth" }) },
      { section: "infra", fact: makeFact({ claim: "bridge up", status: "verified", observed_at: iso(T), source: "probe:bridge", verified_by: "probe:bridge" }) },
    ],
    previous: null,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  assert.match(summary, /P0=launch/);
  assert.match(summary, /Cursor GitHub-app gate/);
  assert.match(summary, /infra=ok/);
});

test("core defaults expose agents and Show HN clock seed", () => {
  assert.ok(CORE_AGENTS.includes("chief-of-staff"));
  assert.ok(CORE_AGENTS.includes("grok"));
  const claims = defaultClockClaims(T);
  assert.ok(claims.some((f) => /Show HN/i.test(f.claim) && f.status === "reported"));
});

import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { collectObservations } from "../src/fleet-truth/collect.mjs";

async function memStore() {
  const redis = createMemoryRedis();
  return createStore(redis, { space: "madez", compat: false });
}

test("collectObservations maps blocked and active jobs plus plan lanes", async () => {
  const store = await memStore();
  await store.setWho("job", "blocked-1", { title: "Console access", details: { plan: "launch", lane: "p0" } });
  await store.setNow("job", "blocked-1", { stage: "blocked", blocked_on: { type: "decision", note: "Mikey Cursor gate" } });
  await store.setWho("job", "active-1", { title: "Deploy 71e23e2", details: { plan: "launch" } });
  await store.setNow("job", "active-1", { stage: "active" });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: CORE_AGENTS });
  const blockers = observations.filter((o) => o.section === "blockers");
  const launch = observations.filter((o) => o.section === "launch");
  const lanes = observations.filter((o) => o.section === "lanes");
  assert.ok(blockers.some((o) => o.fact.source === "job:blocked-1" && o.fact.status === "verified"));
  assert.ok(launch.some((o) => o.fact.source === "job:active-1" && /Deploy/.test(o.fact.claim)));
  assert.ok(lanes.some((o) => /launch/i.test(o.fact.claim)));
});

test("collectObservations emits plan metadata unavailable when no plans", async () => {
  const store = await memStore();
  await store.setWho("job", "plain", { title: "No plan" });
  await store.setNow("job", "plain", { stage: "open" });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: [] });
  assert.ok(observations.some((o) => o.section === "lanes" && o.fact.claim === "plan metadata unavailable" && o.fact.status === "unknown"));
});

test("collectObservations counts unanswered handoffs for core agents", async () => {
  const store = await memStore();
  const agent = "grok";
  await store.setWho("agent", agent, { name: "Infra" });
  await store.append("agent", agent, {
    ts: T - 3600e3,
    kind: "handoff",
    by: "agent:hermes",
    to: "agent:grok",
    trail: "handoffX-1",
    summary: "do the thing",
  });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: ["grok"] });
  const agents = observations.filter((o) => o.section === "agents");
  assert.ok(agents.some((o) => /unanswered handoffs:\s*1/i.test(o.fact.claim) && /grok/.test(o.fact.claim)));
});

test("collectObservations does not copy coordination feed into observations", async () => {
  const store = await memStore();
  await store.append("channel", "agent-coordination", {
    ts: T - 1000,
    kind: "memo",
    by: "agent:codex",
    trail: "noise-1",
    summary: "UNIQUE_FEED_NOISE_SHOULD_NOT_APPEAR",
  });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: [] });
  assert.equal(observations.some((o) => String(o.fact.claim).includes("UNIQUE_FEED_NOISE_SHOULD_NOT_APPEAR")), false);
});

test("collectObservations probes: 200 verified, 401 unknown", async () => {
  const store = await memStore();
  const probes = [{ id: "bridge", url: "http://example/health", expect_status: 200 }];
  const ok = await collectObservations(store, {
    nowMs: T,
    coreAgents: [],
    probes,
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.ok(ok.observations.some((o) => o.section === "infra" && o.fact.status === "verified" && /bridge/.test(o.fact.claim)));
  const bad = await collectObservations(store, {
    nowMs: T,
    coreAgents: [],
    probes,
    fetchImpl: async () => ({ status: 401 }),
  });
  assert.ok(bad.observations.some((o) => o.section === "infra" && o.fact.status === "unknown" && /bridge/.test(o.fact.claim)));
});

test("collectObservations scrubs secrets in claims", async () => {
  const store = await memStore();
  await store.setWho("job", "sec", { title: "Rotate Bearer abcdefghijklmnop now" });
  await store.setNow("job", "sec", { stage: "active" });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: [] });
  const json = JSON.stringify(observations);
  assert.equal(json.includes("abcdefghijklmnop"), false);
  assert.match(json, /\[REDACTED\]/);
});

import { ensureWho, publishBoard } from "../src/fleet-truth/publish.mjs";

test("ensureWho writes channel Who for fleet-truth", async () => {
  const store = await memStore();
  await ensureWho(store, { nowMs: T });
  const who = await store.getWho("channel", "fleet-truth");
  assert.equal(who.schema, "fleet-truth/v1");
  assert.equal(who.owner, "agent:fleet-truth");
  assert.match(String(who.cadence), /9/);
  assert.ok(who.purpose);
});

test("publishBoard writes Now checkup and coordination pointer", async () => {
  const store = await memStore();
  const built = buildBoard({
    observations: [{
      section: "infra",
      fact: makeFact({ claim: "bridge up", status: "verified", observed_at: iso(T), source: "probe:bridge", verified_by: "probe:bridge" }),
    }],
    previous: null,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  const r1 = await publishBoard(store, { ...built, trail: built.now.trail, nowMs: T, seedWho: true });
  assert.equal(r1.trail, "fleetTruth-20261104-midday");
  const now = await store.getNow("channel", "fleet-truth");
  assert.equal(now.trail, r1.trail);
  assert.ok(now.summary);
  assert.equal(now.board.schema, "fleet-truth/v1");
  const checkups = (await store.readLog("channel", "fleet-truth", { reverse: true, limit: 5 })).filter((e) => e.kind === "checkup");
  assert.equal(checkups[0].by, "agent:fleet-truth");
  assert.equal(checkups[0].trail, r1.trail);
  assert.ok(checkups[0].summary.length <= 1000);
  const pointers = (await store.readLog("channel", "agent-coordination", { reverse: true, limit: 5 })).filter((e) => e.trail === r1.trail);
  assert.equal(pointers[0].kind, "memo");
  const r2 = await publishBoard(store, {
    summary: built.summary,
    now: { ...built.now, refreshed_at: iso(T + 60_000) },
    trail: built.now.trail,
    nowMs: T + 60_000,
  });
  const checkups2 = (await store.readLog("channel", "fleet-truth")).filter((e) => e.kind === "checkup");
  assert.ok(checkups2.length >= 2);
  const now2 = await store.getNow("channel", "fleet-truth");
  assert.equal(now2.board.refreshed_at, iso(T + 60_000));
  assert.ok(r2.checkup_ts);
});

import { createMemoryRedis as memRedis } from "../src/lib/memory-redis.mjs";
import { runOnce, lockKey } from "../src/fleet-truth/run.mjs";

test("runOnce skips when not a slot hour", async () => {
  const redis = memRedis();
  const tenEt = Date.parse("2026-11-04T15:00:00.000Z"); // 10:00 ET
  const r = await runOnce(redis, { space: "madez", nowMs: tenEt });
  assert.equal(r.skipped, "not_a_slot");
  const store = createStore(redis, { space: "madez", compat: false });
  const now = await store.getNow("channel", "fleet-truth");
  assert.equal(Object.keys(now || {}).length, 0);
});

test("runOnce manual slot publishes and dry writes nothing", async () => {
  const redis = memRedis();
  const dry = await runOnce(redis, { space: "madez", nowMs: T, slot: "manual", dry: true, seedWho: true });
  assert.equal(dry.ok, true);
  assert.ok(dry.summary);
  const store = createStore(redis, { space: "madez", compat: false });
  assert.equal(Object.keys((await store.getNow("channel", "fleet-truth")) || {}).length, 0);

  const live = await runOnce(redis, { space: "madez", nowMs: T, slot: "manual", seedWho: true });
  assert.equal(live.ok, true);
  assert.match(live.trail, /manual$/);
  const now = await store.getNow("channel", "fleet-truth");
  assert.ok(now.summary);
  assert.equal(now.slot, "manual");
});

test("runOnce lock skips second concurrent publish", async () => {
  const redis = memRedis();
  const key = lockKey("madez", "2026-11-04", "midday");
  await redis("SET", key, "other", "NX", "EX", "600");
  const r = await runOnce(redis, { space: "madez", nowMs: T, slot: "midday", seedWho: true });
  assert.equal(r.skipped, "locked");
  const store = createStore(redis, { space: "madez", compat: false });
  const logs = await store.readLog("channel", "fleet-truth");
  assert.equal(logs.filter((e) => e.kind === "checkup").length, 0);
});

test("runOnce happy path at midday writes Now", async () => {
  const redis = memRedis();
  const r = await runOnce(redis, { space: "madez", nowMs: T, seedWho: true });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, undefined);
  const store = createStore(redis, { space: "madez", compat: false });
  const now = await store.getNow("channel", "fleet-truth");
  assert.ok(now.board);
  assert.equal(now.trail, r.trail);
});

test("buildBoard replaces collected sections so cleared blockers leave Now", () => {
  const prev = emptyBoard({ refreshed_at: iso(T - 3600e3), slot: "morning", runner: "agent:fleet-truth", trail: "t0" });
  prev.blockers.items = [makeFact({ claim: "Console: Mikey gate", status: "verified", observed_at: iso(T - 3600e3), source: "job:blocked-1", verified_by: "agent:fleet-truth" })];
  prev.infra.items = [makeFact({ claim: "no probes configured", status: "unknown", observed_at: iso(T - 3600e3), source: "fleet-truth:probes" })];
  const { now, summary } = buildBoard({
    observations: [
      { section: "infra", fact: makeFact({ claim: "bridge up (HTTP 200)", status: "verified", observed_at: iso(T), source: "probe:bridge", verified_by: "probe:bridge" }) },
      { section: "lanes", fact: makeFact({ claim: "P0=launch", status: "verified", observed_at: iso(T), source: "plan:launch", verified_by: "agent:fleet-truth" }) },
    ],
    previous: prev,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  assert.equal(now.blockers.items.length, 0);
  assert.equal(now.infra.items.length, 1);
  assert.equal(now.infra.items[0].claim, "bridge up (HTTP 200)");
  assert.match(summary, /infra=ok/);
  assert.match(summary, /top_blocker=none/);
});

test("buildBoard ages old verified carried clock facts to stale in same build", () => {
  const prev = emptyBoard({ refreshed_at: iso(T - FRESHNESS_MS - 5000), slot: "morning", runner: "agent:fleet-truth", trail: "t0" });
  prev.clock.items = [makeFact({ claim: "old clock", status: "verified", observed_at: iso(T - FRESHNESS_MS - 5000), source: "core:x", verified_by: "agent:fleet-truth" })];
  const { now } = buildBoard({ observations: [], previous: prev, nowMs: T, slot: "midday", runner: "agent:fleet-truth" });
  assert.equal(now.clock.items.find((f) => f.claim === "old clock").status, "stale");
});

test("infraRollup unknown when only no probes configured", () => {
  const { summary } = buildBoard({
    observations: [{ section: "infra", fact: makeFact({ claim: "no probes configured", status: "unknown", observed_at: iso(T), source: "fleet-truth:probes" }) }],
    previous: null,
    nowMs: T,
    slot: "midday",
    runner: "agent:fleet-truth",
  });
  assert.match(summary, /infra=unknown/);
});

test("scrubSecrets redacts sk-ant, ghp_, and redis userinfo", () => {
  const cleaned = scrubSecrets({
    a: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    b: "ghp_abcdefghijklmnopqrstuvwxyz012345",
    c: "redis://default:s3cr3tpass@host:6379",
  });
  const json = JSON.stringify(cleaned);
  assert.equal(json.includes("abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(json.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(json.includes("s3cr3tpass"), false);
});

test("runOnce keeps slot lock after success so second same-slot call skips", async () => {
  const redis = memRedis();
  const first = await runOnce(redis, { space: "madez", nowMs: T, seedWho: true });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, undefined);
  const second = await runOnce(redis, { space: "madez", nowMs: T + 1000, seedWho: true });
  assert.equal(second.skipped, "locked");
  const store = createStore(redis, { space: "madez", compat: false });
  const checkups = (await store.readLog("channel", "fleet-truth")).filter((e) => e.kind === "checkup");
  assert.equal(checkups.length, 1);
});

test("collectAgents counts handoffs from newest log slice", async () => {
  const store = await memStore();
  const agent = "grok";
  await store.setWho("agent", agent, { name: "Infra" });
  // 250 in-window noise entries (older within 48h), then one newest handoff
  for (let i = 0; i < 250; i++) {
    await store.append("agent", agent, { ts: T - 3_600_000 - i, kind: "memo", by: "agent:grok", trail: `old-${i}`, summary: "noise" });
  }
  await store.append("agent", agent, {
    ts: T - 1000,
    kind: "handoff",
    by: "agent:hermes",
    to: "agent:grok",
    trail: "handoff-new-1",
    summary: "new work",
  });
  const { observations } = await collectObservations(store, { nowMs: T, coreAgents: ["grok"] });
  assert.ok(observations.some((o) => o.section === "agents" && /unanswered handoffs:\s*1/.test(o.fact.claim)));
});
