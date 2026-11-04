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
