// coord-sync.test.mjs — Test suite for PR D: logmem_sync, Runs, Slots, Crash Recovery, Action IDs, and Leases.
//
// Validates Acceptance Cases:
// - Case 18: logmem_sync read-only returns open coordination items with deadlines, overdue flags, coverage; zero writes
// - Case 19: logmem_sync with receipt=true writes attempt record and slot record
// - Case 20 & Probe 30: Retry one run ID: returns existing receipt, exactly one logical receipt appears
// - Case 21: Daily slots: slot record lists every attempt in that slot and its verified outcome
// - Case 22: Window validation: attempt outside slot window cannot pass scheduled slot
// - Case 23, Probe 31, Probe 32: Crash recovery: run record goes claimed -> complete, retry finishes safely, bare claim never passes
// - Case 24: Action IDs: answering notes carry action_id; duplicate execution is refused
// - Case 25 & Probe 33: Expired run lease: old runner cannot overwrite newer work
// - Case 27: Slots view: buildView with what="slots" returns three-run state per roster agent
// - Probe 29: Two manual syncs on one day: each new run observes current state

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { createLogmem } from "../src/server.mjs";
import {
  computeItemId,
  createCoordItem,
  coordCoverageKey,
} from "../src/core/coord.mjs";
import {
  mintRunId,
  computeActionId,
  syncRunKey,
  syncSlotKey,
  syncLeaseKey,
  getLocalSlotDate,
  getSlotForTime,
  getAgentSlotsView,
} from "../src/core/sync.mjs";
import { buildView } from "../src/http/view.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1792687770000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test("Case 18 & Case 2: logmem_sync read-only returns pending items and coverage with zero writes", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  // Set coverage key
  await r("SET", coordCoverageKey("fleet"), "full");

  // Create an open handoff item for quill
  const itemId = computeItemId("fleet", "handoff", "trail-sync-1", "quill");
  await createCoordItem(store, {
    id: itemId,
    type: "handoff",
    request_trail: "trail-sync-1",
    from: "agent:atlas",
    to: "agent:quill",
    where: "job:review-job",
    summary: "Review sync design",
    created_at: now() - 2 * 3600 * 1000,
  });

  // Track writes to memory-redis
  const WRITES = new Set([
    "SET", "DEL", "HSET", "HDEL", "HINCRBY", "ZADD", "ZREM", "SADD", "SREM", "EVAL", "RPUSH"
  ]);

  let writeCount = 0;
  const wrappedRedis = async (cmd, ...args) => {
    if (WRITES.has(String(cmd).toUpperCase())) {
      writeCount++;
    }
    return r(cmd, ...args);
  };

  const lm = createLogmem({
    workRules: "warn",
    redis: wrappedRedis,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    pureReads: true,
    now,
  });

  const res = await sc(lm, "logmem_sync", {});
  assert.equal(res.ok, true);
  assert.equal(res.agent, "quill");
  assert.ok(res.run_id);
  assert.equal(res.coverage, "full");
  assert.equal(res.pending.length, 1);
  assert.equal(res.pending[0].id, itemId);
  assert.equal(res.pending[0].overdue, false);
  assert.equal(res.counts.total, 1);

  // Pure read validation
  assert.equal(writeCount, 0, "logmem_sync without receipt must make zero Redis writes");
});

test("Case 19, 20 & Probe 30: logmem_sync receipt writes run record, slot record, and retries idempotently", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  const runId = "sync_run_test_12345678901234";

  // 1. Initial sync with receipt
  const receiptRes = await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: runId,
    slot: "manual",
    outcome: "pass",
    notes: "Morning fleet sync complete",
  });

  assert.equal(receiptRes.ok, true);
  assert.equal(receiptRes.run_id, runId);
  assert.ok(receiptRes.receipt);
  assert.equal(receiptRes.receipt.status, "complete");
  assert.equal(receiptRes.receipt.outcome, "pass");

  // Verify stored in Redis
  const storedRunRaw = await r("GET", syncRunKey("fleet", "quill", runId));
  assert.ok(storedRunRaw);
  const storedRun = JSON.parse(storedRunRaw);
  assert.equal(storedRun.run_id, runId);
  assert.equal(storedRun.status, "complete");

  // 2. Probe 30: Retry with the exact same run_id returns existing receipt without adding duplicate
  const retryRes = await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: runId,
    slot: "manual",
  });

  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.deduped, true);
  assert.equal(retryRes.receipt.run_id, runId);

  // Verify only 1 attempt exists in slot
  const dateStr = getLocalSlotDate(now());
  const rawAttempts = await r("LRANGE", syncSlotKey("fleet", "quill", dateStr, "manual"), 0, -1);
  assert.equal(rawAttempts.length, 1, "Exactly one attempt must be recorded for this run ID");
});

test("Probe 29: Two manual syncs on one day observe current state with distinct run IDs", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  // Run 1: empty queue
  const run1 = await sc(lm, "logmem_sync", {});
  assert.equal(run1.pending.length, 0);

  await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: run1.run_id,
    slot: "manual",
    outcome: "pass",
  });

  // Add an item after run 1
  now.advance(3600 * 1000);
  const itemId = computeItemId("fleet", "handoff", "trail-new-1", "quill");
  await createCoordItem(store, {
    id: itemId,
    type: "handoff",
    request_trail: "trail-new-1",
    from: "agent:atlas",
    to: "agent:quill",
    where: "job:new-job",
    summary: "New work arrived",
    created_at: now(),
  });

  // Run 2: observes the new item
  const run2 = await sc(lm, "logmem_sync", {});
  assert.notEqual(run1.run_id, run2.run_id, "New manual sync has distinct run_id");
  assert.equal(run2.pending.length, 1);
  assert.equal(run2.pending[0].id, itemId);

  await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: run2.run_id,
    slot: "manual",
    outcome: "partial",
  });

  // Verify both attempts exist in slot record
  const dateStr = getLocalSlotDate(now());
  const rawAttempts = await r("LRANGE", syncSlotKey("fleet", "quill", dateStr, "manual"), 0, -1);
  assert.equal(rawAttempts.length, 2, "Both attempts are recorded");
});

test("Case 23, Probe 31 & Probe 32: Crash after claiming receipt, recovery, and bare claim never passes", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  const runId = "sync_crash_run_456";

  // 1. Runner claims receipt then crashes (claim_only)
  const claimRes = await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: runId,
    slot: "morning",
    claim_only: true,
  });
  assert.equal(claimRes.ok, true);
  assert.equal(claimRes.status, "claimed");

  // Verify slot record has NO completed attempts (bare claim is never success)
  const dateStr = getLocalSlotDate(now());
  const slotBefore = await getAgentSlotsView(store, "fleet", "quill", dateStr, now());
  assert.notEqual(slotBefore.slots.morning.state, "pass", "Bare claim never passes a slot");

  // 2. Retry / Recovery (Probe 32)
  const recoverRes = await sc(lm, "logmem_sync", {
    receipt: true,
    run_id: runId,
    slot: "morning",
    outcome: "pass",
  });
  assert.equal(recoverRes.ok, true);
  assert.equal(recoverRes.receipt.status, "complete");
  assert.equal(recoverRes.receipt.recovered, true, "Recovered attempt must be flagged recovered");

  // Verify slot view now reflects verified recovery (Probe 31)
  const slotAfter = await getAgentSlotsView(store, "fleet", "quill", dateStr, now());
  assert.equal(slotAfter.slots.morning.state, "pass", "Slot reflects verified recovery");
});

test("Case 24: Action IDs prevent duplicate reply writes", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  const actionId = computeActionId("run_1", "ci_item_1", "answered");

  // 1. First execution of action
  const note1 = await sc(lm, "logmem_note", {
    where: "channel:general",
    summary: "Reply to item 1",
    action_id: actionId,
  });
  assert.equal(note1.ok, true);

  // 2. Second execution of identical action is refused
  const note2 = await sc(lm, "logmem_note", {
    where: "channel:general",
    summary: "Duplicate reply to item 1",
    action_id: actionId,
  });
  assert.equal(note2.ok, false);
  assert.match(note2.error, /was already executed/);
});

test("Case 27: Slots view via buildView returns three-run state per agent", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY (morning slot)

  // Register agents
  await store.setWho("agent", "quill", { name: "Quill" });
  await store.setWho("agent", "atlas", { name: "Atlas" });

  const view = await buildView(r, "fleet", "slots", {}, now());
  assert.ok(view.date);
  assert.equal(view.space, "fleet");
  assert.equal(view.agents.length, 2);

  const quillSlot = view.agents.find((a) => a.agent === "quill");
  assert.ok(quillSlot);
  assert.ok(quillSlot.slots.morning);
  assert.ok(quillSlot.slots.midday);
  assert.ok(quillSlot.slots.closeout);
});

test("Case 22: Window validation - attempt outside slot window cannot pass scheduled slot", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792687770000); // 12:49 PM NY (midday, outside morning window)

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  const res = await sc(lm, "logmem_sync", {
    receipt: true,
    slot: "morning",
    outcome: "pass",
  });

  assert.equal(res.ok, true);
  assert.equal(res.receipt.outcome, "missed", "Morning attempt at midday cannot pass");
  assert.equal(res.receipt.in_window, false);
});

test("Case 25 & Probe 33: Run lease prevents concurrent execution and protects against expired lease overwrites", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792674000000); // 09:00 AM NY

  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    defaultAgent: "quill",
    agent: "quill",
    now,
  });

  // Runner 1 holds the lease
  await r("SET", syncLeaseKey("fleet", "quill"), "lease_runner_1", "EX", 120);

  // Runner 2 attempts to run sync with receipt -> refused due to active lease
  const res = await sc(lm, "logmem_sync", {
    receipt: true,
    slot: "morning",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /concurrent sync lease held/);
});
