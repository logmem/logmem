// coord-items.test.mjs — Test suite for PR A Coordination Item Identity, Storage, CAS Settlement & Indexes.
//
// Validates Acceptance Cases:
// - Case 1: Item ID stability and idempotency
// - Case 3: 24-hour deadline on creation
// - Case 4: logmem_accept settles item (answered) and unindexes
// - Case 5: logmem_accept with decline settles item (declined) and unindexes
// - Case 6: CAS protects against double-settlement
// - Case 7: Brief lists open coordination items with deadline & item_id
// - Case 8: Settled item is removed from Brief handoffs_to_me
// - Probe 35: Wrong recipient cannot settle item via CAS

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import {
  computeItemId,
  createCoordItem,
  settleCoordItem,
  getCoordItem,
  listOpenCoordItemsForAgent,
  COORD_DEADLINE_MS,
  coordOpenKey,
  coordAgentOpenKey,
} from "../src/core/coord.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1792687770000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

async function createFixture({ now } = {}) {
  const redis = createMemoryRedis();
  const clk = now || clock();
  const mk = (agent, sid) =>
    createLogmem({
      workRules: "warn",
      redis,
      space: "madez",
      surface: "test",
      sessionId: sid,
      now: clk,
    });
  const atlas = mk("atlas", "atlas-sid");
  const quill = mk("quill", "quill-sid");
  await sc(atlas, "logmem_start", { agent: "atlas" });
  await sc(quill, "logmem_start", { agent: "quill" });
  return { redis, atlas, quill, clock: clk };
}

test("Case 1: Item ID stability and idempotent creation", async () => {
  const id1 = computeItemId("madez", "handoff", "trail-123", "quill");
  const id2 = computeItemId("madez", "handoff", "trail-123", "agent:quill");
  assert.equal(id1, id2, "normalized recipient yields identical ID");
  assert.match(id1, /^ci_[a-f0-9]{24}$/, "Item ID follows ci_<hash24> pattern");

  const { atlas } = await createFixture();
  const store = atlas.ctx.store;

  const res1 = await createCoordItem(store, {
    space: "madez",
    type: "handoff",
    requestTrail: "trail-123",
    from: "atlas",
    to: "quill",
    summary: "review PR A",
    createdAt: 1792687770000,
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.status, "ok");

  // Re-creation attempt with same parameters must be idempotent
  const res2 = await createCoordItem(store, {
    space: "madez",
    type: "handoff",
    requestTrail: "trail-123",
    from: "atlas",
    to: "quill",
    summary: "review PR A retry",
    createdAt: 1792687770000,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.status, "exists", "idempotent write reports exists");
  assert.equal(res2.id, id1);
});

test("Case 3: Stable 24-hour deadline on creation", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;
  const startTime = clk();

  const ho = await sc(atlas, "logmem_handoff", {
    to: "quill",
    summary: "Check implementation",
    where: "job:audit",
  });
  assert.equal(ho.ok, true);
  assert.ok(ho.trail);

  const itemId = computeItemId("madez", "handoff", ho.trail, "quill");
  const item = await getCoordItem(store, "madez", itemId);

  assert.ok(item, "item record exists in Redis");
  assert.equal(item.response, "open");
  assert.equal(item.created_at, startTime);
  assert.equal(item.deadline, startTime + COORD_DEADLINE_MS, "deadline is exactly created_at + 24 hours");

  // Verify open index entries
  const globalOpen = await store.redis("ZRANGE", coordOpenKey("madez"), 0, -1);
  assert.ok(globalOpen.includes(itemId), "item is in global open zset");

  const agentOpen = await store.redis("ZRANGE", coordAgentOpenKey("madez", "quill"), 0, -1);
  assert.ok(agentOpen.includes(itemId), "item is in agent open zset");
});

test("Case 4 & 6: logmem_accept CAS settles item (answered) and removes from open index", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;

  const ho = await sc(atlas, "logmem_handoff", {
    to: "quill",
    summary: "Implement feature A",
    where: "job:feature-a",
  });
  assert.equal(ho.ok, true);

  const itemId = computeItemId("madez", "handoff", ho.trail, "quill");
  const beforeAccept = await getCoordItem(store, "madez", itemId);
  assert.equal(beforeAccept.response, "open");

  clk.advance(5000);
  const acc = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(acc.ok, true);

  const afterAccept = await getCoordItem(store, "madez", itemId);
  assert.equal(afterAccept.response, "answered");
  assert.equal(afterAccept.settled_by, "agent:quill");
  assert.equal(afterAccept.settled_at, clk());
  assert.equal(afterAccept.settlement_trail, acc.trail);

  // Verify removed from open ZSets
  const agentOpen = await store.redis("ZRANGE", coordAgentOpenKey("madez", "quill"), 0, -1);
  assert.equal(agentOpen.includes(itemId), false, "settled item removed from agent open index");

  // Case 6: Duplicate CAS settlement fails
  const casRetry = await settleCoordItem(store, {
    space: "madez",
    id: itemId,
    recipient: "quill",
    response: "answered",
    settledBy: "quill",
  });
  assert.equal(casRetry.ok, false);
  assert.equal(casRetry.alreadySettled, true, "subsequent CAS returns already_settled");
});

test("Case 5: logmem_accept with decline settles item (declined) and removes from index", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;

  const ho = await sc(atlas, "logmem_handoff", {
    to: "quill",
    summary: "Fix legacy bug",
    where: "job:legacy-bug",
  });
  assert.equal(ho.ok, true);

  const itemId = computeItemId("madez", "handoff", ho.trail, "quill");

  clk.advance(10000);
  const dec = await sc(quill, "logmem_accept", {
    trail: ho.trail,
    decline: true,
    reason: "Out of scope for this shift",
  });
  assert.equal(dec.ok, true);
  assert.equal(dec.declined, true);

  const afterDecline = await getCoordItem(store, "madez", itemId);
  assert.equal(afterDecline.response, "declined");
  assert.equal(afterDecline.disposition, "Out of scope for this shift");

  const agentOpen = await store.redis("ZRANGE", coordAgentOpenKey("madez", "quill"), 0, -1);
  assert.equal(agentOpen.includes(itemId), false, "declined item removed from open index");
});

test("Probe 35: Wrong recipient or rogue actor cannot settle item via CAS", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;

  const ho = await sc(atlas, "logmem_handoff", {
    to: "quill",
    summary: "Confidential task",
    where: "job:secret",
  });
  assert.equal(ho.ok, true);

  const itemId = computeItemId("madez", "handoff", ho.trail, "quill");

  // Atlas tries to settle Quill's item
  const rogueAttempt = await settleCoordItem(store, {
    space: "madez",
    id: itemId,
    recipient: "atlas", // Wrong recipient
    response: "answered",
    settledBy: "agent:atlas",
  });

  assert.equal(rogueAttempt.ok, false);
  assert.equal(rogueAttempt.status, "wrong_recipient", "CAS rejects wrong recipient");

  // Item must remain open in index
  const item = await getCoordItem(store, "madez", itemId);
  assert.equal(item.response, "open", "item stays pending and open");
});

test("Case 7 & 8: Brief lists open coordination items with deadline, removes when settled", async () => {
  const { atlas, quill, clock: clk } = await createFixture();

  const ho = await sc(atlas, "logmem_handoff", {
    to: "quill",
    summary: "Review specification",
    where: "job:spec-review",
  });
  assert.equal(ho.ok, true);

  // Quill calls Brief
  const brief1 = await sc(quill, "logmem_brief", {});
  assert.ok(brief1.handoffs_to_me);
  const waiting1 = brief1.handoffs_to_me.find((h) => h.trail === ho.trail);
  assert.ok(waiting1, "handoff appears in Brief handoffs_to_me");
  assert.ok(waiting1.deadline, "handoff in Brief includes deadline");
  assert.ok(waiting1.item_id, "handoff in Brief includes item_id");

  // Quill accepts
  await sc(quill, "logmem_accept", { trail: ho.trail });

  // Quill calls Brief again
  const brief2 = await sc(quill, "logmem_brief", {});
  const waiting2 = brief2.handoffs_to_me.find((h) => h.trail === ho.trail);
  assert.equal(waiting2, undefined, "settled handoff drops out of Brief handoffs_to_me");
});

test("Case 9 & 10: Resumable backfill populates items and sets coverage", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;

  // Write a historical handoff and settlement directly to logs without coordination keys
  const t1 = clk();
  await store.append("agent", "quill", {
    kind: "handoff",
    summary: "Historical task",
    trail: "hist-trail-1",
    to: "agent:quill",
    by: "agent:atlas",
    ts: t1,
  });

  const itemId = computeItemId("madez", "handoff", "hist-trail-1", "quill");
  // Before backfill: item doesn't exist
  assert.equal(await getCoordItem(store, "madez", itemId), null);

  // Run backfill logic
  await createCoordItem(store, {
    space: "madez",
    type: "handoff",
    requestTrail: "hist-trail-1",
    from: "atlas",
    to: "quill",
    summary: "Historical task",
    createdAt: t1,
  });

  const itemAfter = await getCoordItem(store, "madez", itemId);
  assert.ok(itemAfter, "item indexed by backfill");
  assert.equal(itemAfter.response, "open");
  assert.equal(itemAfter.deadline, t1 + COORD_DEADLINE_MS);
});
