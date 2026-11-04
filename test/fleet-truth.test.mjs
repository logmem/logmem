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

test("buildBoard never upgrades reported to verified without observation", () => {
  const prev = emptyBoard({ refreshed_at: iso(T - 1000), slot: "morning", runner: "agent:fleet-truth", trail: "t" });
  prev.lanes.items = [makeFact({ claim: "P0=launch", status: "reported", observed_at: iso(T - 1000), source: "job:x" })];
  const { now } = buildBoard({ observations: [], previous: prev, nowMs: T, slot: "midday", runner: "agent:fleet-truth" });
  assert.equal(now.lanes.items[0].status, "reported");
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
