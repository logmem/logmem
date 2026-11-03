import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { reconcileStaleHandoffs } from "../src/core/reconcile.mjs";
import { auditView } from "../src/http/view.mjs";
import { runCheck } from "../scripts/dogfood-check.mjs";

test("reconcileStaleHandoffs: archives handoffs older than 48h, leaves fresh handoffs open, and satisfies dogfood health", async () => {
  const redis = createMemoryRedis();
  const space = "test-space";
  const store = createStore(redis, { space });

  const now = 100 * 3600 * 1000; // arbitrary base timestamp
  const hOldTs = now - (50 * 3600 * 1000); // 50 hours old -> stale
  const hFreshTs = now - (10 * 3600 * 1000); // 10 hours old -> fresh

  // Setup: Sender 'hermes' sends two handoffs to recipient 'quill'
  await store.append("agent", "quill", {
    ts: hOldTs,
    kind: "handoff",
    by: "agent:hermes",
    to: "agent:quill",
    trail: "trail-old-orphan-1",
    summary: "Old orphan task that was never accepted",
    job: "job:old-task-1",
  });

  await store.append("agent", "quill", {
    ts: hFreshTs,
    kind: "handoff",
    by: "agent:hermes",
    to: "agent:quill",
    trail: "trail-fresh-task-2",
    summary: "Fresh pending task within 48 hours",
    job: "job:fresh-task-2",
  });

  // Verify before reconcile: auditView returns 2 pending items
  let audit = await auditView(store, redis, space, {}, now);
  assert.equal(audit.pending.items.length, 2);

  // Run reconciler with 48h threshold
  const res = await reconcileStaleHandoffs(store, {
    maxAgeMs: 48 * 3600 * 1000,
    now,
    reason: "Auto-reconciled test orphan (>48h)",
  });

  assert.equal(res.count, 1);
  assert.equal(res.reconciled[0].trail, "trail-old-orphan-1");

  // Verify after reconcile:
  // 1. auditView now only contains the 1 fresh item ('trail-fresh-task-2')
  audit = await auditView(store, redis, space, {}, now);
  assert.equal(audit.pending.items.length, 1);
  assert.equal(audit.pending.items[0].request_trail, "trail-fresh-task-2");

  // 2. Recipient 'quill' has an immutable decline entry in its log for 'trail-old-orphan-1'
  const log = await store.readLog("agent", "quill", { reverse: true });
  const declineEntry = log.find((e) => e.origin === "trail-old-orphan-1");
  assert.ok(declineEntry, "Decline entry recorded in recipient's log");
  assert.equal(declineEntry.kind, "feedback");
  assert.equal(declineEntry.payload?.declined, true);
  assert.equal(declineEntry.payload?.auto_reconciled, true);

  // 3. Linked job 'job:old-task-1' also receives the decline entry
  const jobLog = await store.readLog("job", "old-task-1", { reverse: true });
  assert.ok(jobLog.some((e) => e.origin === "trail-old-orphan-1"));

  // 4. Idempotency: Re-running reconcile yields 0 items
  const res2 = await reconcileStaleHandoffs(store, {
    maxAgeMs: 48 * 3600 * 1000,
    now,
  });
  assert.equal(res2.count, 0);

  // 5. Dogfood checkup: the old handoff is settled and does NOT fail unanswered_24h
  // In dogfood-check, lookback window covers the old handoff
  const check = await runCheck(redis, {
    space,
    mirrorSpaces: [],
    now,
    write: false,
    stuck: false,
  });
  assert.equal(check.day.unanswered_24h, 0, "No unanswered handoffs >24h flagged by dogfood check");
});

test("reconcileStaleHandoffs: surfaces settlement failures and aborts writing decline if settlement fails", async () => {
  const redis = createMemoryRedis();
  const space = "test-space-fail";
  const store = createStore(redis, { space });

  const now = 100 * 3600 * 1000;
  const hOldTs = now - (50 * 3600 * 1000);

  // Setup: Sender 'hermes' sends handoff to recipient 'quill'
  await store.append("agent", "quill", {
    ts: hOldTs,
    kind: "handoff",
    by: "agent:hermes",
    to: "agent:quill",
    trail: "trail-failing-settle-1",
    summary: "Task that will fail settlement",
  });

  const { createCoordItem, computeItemId } = await import("../src/core/coord.mjs");
  const id = computeItemId(space, "handoff", "trail-failing-settle-1", "quill");

  // Create coordination item
  await createCoordItem(store, {
    space,
    type: "handoff",
    requestTrail: "trail-failing-settle-1",
    from: "agent:hermes",
    to: "agent:quill",
    createdAt: hOldTs,
  });

  // Corrupt coordination item by deleting its recipient field so CAS fails with wrong_recipient
  const itemKey = `lm:${space}:coord:item:${id}`;
  await redis("HSET", itemKey, "to", "agent:someone-else");

  const res = await reconcileStaleHandoffs(store, {
    maxAgeMs: 48 * 3600 * 1000,
    now,
  });

  assert.equal(res.count, 0, "No items reconciled on settlement failure");
  assert.equal(res.failures.length, 1, "Failure surfaced in res.failures");
  assert.match(res.failures[0].error, /Settlement failed/);

  // Decline entry was NOT written to quill's log
  const log = await store.readLog("agent", "quill", { reverse: true });
  assert.equal(log.filter(e => e.kind === "feedback").length, 0, "No decline entry written on failure");
});
