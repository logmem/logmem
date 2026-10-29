// coord-audit.test.mjs — Test suite for PR B: Audit Page & Item Nudge.
//
// Validates Acceptance Cases:
// - Case 2: Pure reads stay write-free (audit view writes nothing to Redis)
// - Case 11: Audit page lists pending coordination items sorted by overdue duration and deadline
// - Case 12: Filters for recipient, plan, type, and overdue state; cursor paging
// - Case 13: Coverage reporting and future-timestamp data error flagging
// - Case 14: Daily scorecard history retained alongside pending items
// - Case 26: Item nudge resolves recipient from canonical record, writes ping to recipient and source log
// - Probe 34: Nudge route compatibility (job vs item mutual exclusivity, 400 on both/neither, 1h cooldown 429, settled item returns status without write)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { createLogmem } from "../src/server.mjs";
import {
  computeItemId,
  createCoordItem,
  settleCoordItem,
  getCoordItem,
  coordCoverageKey,
} from "../src/core/coord.mjs";
import { auditView, buildView } from "../src/http/view.mjs";
import { nudge, WorkError } from "../src/http/work.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1792687770000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

test("Probe 34 & Case 26: Nudge route mutual exclusivity and target validation", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock();

  // 1. Both job and item -> 400
  await assert.rejects(
    async () => {
      await nudge(store, { by: "human:mikey", job: "job-1", item: "ci_123", now });
    },
    (err) => err instanceof WorkError && err.status === 400 && /provide either job or item, not both/.test(err.message)
  );

  // 2. Neither job nor item -> 400
  await assert.rejects(
    async () => {
      await nudge(store, { by: "human:mikey", now });
    },
    (err) => err instanceof WorkError && err.status === 400 && /provide either job or item, not both/.test(err.message)
  );

  // 3. Only person can nudge
  await assert.rejects(
    async () => {
      await nudge(store, { by: "agent:codex", job: "job-1", now });
    },
    (err) => err instanceof WorkError && err.status === 403
  );
});

test("Probe 34 & Case 26: Item nudge resolves recipient from item, enforces 1h cooldown, and handles settled items", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const lm = createLogmem({
    workRules: "warn",
    redis: r,
    space: "fleet",
    surface: "test",
    agent: "claude-code",
  });
  const now = clock(1792687770000);

  // Create a job and an open handoff coordination item
  await lm.callTool("logmem_start", { agent: "claude-code" });
  await store.setWho("job", "audit-feature", { title: "Audit Feature Implementation" });
  await store.setNow("job", "audit-feature", { stage: "active", owner: "agent:claude-code" });

  const handoffRes = await sc(lm, "logmem_handoff", {
    to: "codex",
    create_agent: true,
    summary: "Please review PR B audit page implementation",
    where: "job:audit-feature",
  });
  assert.equal(handoffRes.ok, true);
  assert.ok(handoffRes.trail);
  const itemId = computeItemId("fleet", "handoff", handoffRes.trail, "codex");

  // 1. Nudge the item as a human; recipient in payload should be ignored (resolves to codex from item)
  const nudgeRes = await nudge(store, {
    by: "human:mikey",
    item: itemId,
    agent: "wrong-agent-should-be-ignored",
    note: "Hey codex, review needed urgently",
    now,
  });
  assert.equal(nudgeRes.ok, true);
  assert.equal(nudgeRes.to, "codex");
  assert.equal(nudgeRes.item, itemId);

  // Verify ping was appended to agent:codex log
  const codexLogs = await store.readLog("agent", "codex", { limit: 10 });
  const pingEntry = codexLogs.find((e) => e.kind === "ping" && e.payload?.coord_item === itemId);
  assert.ok(pingEntry, "Ping entry should be in recipient log");
  assert.equal(pingEntry.by, "human:mikey");
  assert.match(pingEntry.summary, /Hey codex, review needed urgently/);

  // Verify ping was appended to job:audit-feature source log
  const jobLogs = await store.readLog("job", "audit-feature", { limit: 10 });
  const jobPing = jobLogs.find((e) => e.kind === "ping" && e.payload?.coord_item === itemId);
  assert.ok(jobPing, "Ping entry should be in source job log");

  // Verify item's last_nudge_at was updated
  const updatedItem = await getCoordItem(store, "fleet", itemId);
  assert.equal(Number(updatedItem.last_nudge_at), now());

  // 2. Cooldown enforcement: nudging again immediately throws 429
  await assert.rejects(
    async () => {
      await nudge(store, {
        by: "human:mikey",
        item: itemId,
        now,
      });
    },
    (err) => err instanceof WorkError && err.status === 429 && /try again in an hour/.test(err.message)
  );

  // 3. Settle the item
  await lm.callTool("logmem_start", { agent: "codex" });
  await lm.callTool("logmem_accept", {
    trail: handoffRes.trail,
    summary: "Audit page approved and verified",
  });

  // Verify settled item
  const settledItem = await getCoordItem(store, "fleet", itemId);
  assert.equal(settledItem.response, "answered");

  // 4. Nudging an already settled item returns settlement state without writing anything
  const preLogCount = (await store.readLog("agent", "codex", { limit: 50 })).length;
  const settledNudgeRes = await nudge(store, {
    by: "human:mikey",
    item: itemId,
    now,
  });
  assert.equal(settledNudgeRes.ok, true);
  assert.equal(settledNudgeRes.settled, true);
  assert.equal(settledNudgeRes.response, "answered");

  // Verify no new log entries were written
  const postLogCount = (await store.readLog("agent", "codex", { limit: 50 })).length;
  assert.equal(preLogCount, postLogCount);
});

test("Case 11 & 12: Audit view sorts items (overdue duration, type), filters, and pages", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792687770000);

  // Create three items:
  // Item 1: Handoff, created at now - 25h (overdue by 1 hour)
  const item1Id = computeItemId("fleet", "handoff", "trail-1", "codex");
  await createCoordItem(store, {
    id: item1Id,
    type: "handoff",
    request_trail: "trail-1",
    from: "agent:claude-code",
    to: "agent:codex",
    where: "job:job-1",
    plan: "fleet-p0",
    summary: "Handoff 1 overdue",
    created_at: now() - 25 * 3600 * 1000,
  });

  // Item 2: Handoff, created at now - 2h (not overdue, deadline in 22h)
  const item2Id = computeItemId("fleet", "handoff", "trail-2", "claude-code");
  await createCoordItem(store, {
    id: item2Id,
    type: "handoff",
    request_trail: "trail-2",
    from: "agent:codex",
    to: "agent:claude-code",
    where: "job:job-2",
    plan: "fleet-p0",
    summary: "Handoff 2 fresh",
    created_at: now() - 2 * 3600 * 1000,
  });

  // Item 3: Seat, created at now - 26h (overdue by 2 hours)
  const item3Id = computeItemId("fleet", "seat", "trail-3", "codex");
  await createCoordItem(store, {
    id: item3Id,
    type: "seat",
    request_trail: "trail-3",
    from: "agent:mikey",
    to: "agent:codex",
    where: "job:job-1",
    plan: "fleet-p0",
    summary: "Seat 3 huddle",
    created_at: now() - 26 * 3600 * 1000,
  });

  // 1. Query full audit view
  const res = await auditView(store, r, "fleet", {}, now());
  assert.equal(res.pending.total, 3);
  assert.equal(res.pending.counts.handoffs, 2);
  assert.equal(res.pending.counts.seats, 1);
  assert.equal(res.pending.counts.overdue, 2);

  // Sorting check:
  // Handoffs lead seats. Within handoffs: overdue item1 comes before item2.
  assert.equal(res.pending.items[0].id, item1Id, "Overdue handoff leads");
  assert.equal(res.pending.items[1].id, item2Id, "Fresh handoff is second");
  assert.equal(res.pending.items[2].id, item3Id, "Seat follows handoffs");

  // 2. Filter by recipient
  const codexView = await auditView(store, r, "fleet", { recipient: "codex" }, now());
  assert.equal(codexView.pending.total, 2);
  assert.ok(codexView.pending.items.every((i) => i.to === "agent:codex"));

  // 3. Filter by type
  const seatView = await auditView(store, r, "fleet", { type: "seat" }, now());
  assert.equal(seatView.pending.total, 1);
  assert.equal(seatView.pending.items[0].id, item3Id);

  // 4. Filter by overdue
  const overdueView = await auditView(store, r, "fleet", { overdue: true }, now());
  assert.equal(overdueView.pending.total, 2);
  assert.ok(overdueView.pending.items.every((i) => now() > i.deadline));

  // 5. Cursor paging with limit 2
  const page1 = await auditView(store, r, "fleet", { limit: "2", cursor: "0" }, now());
  assert.equal(page1.pending.items.length, 2);
  assert.equal(page1.pending.cursor, "2");

  const page2 = await auditView(store, r, "fleet", { limit: "2", cursor: "2" }, now());
  assert.equal(page2.pending.items.length, 1);
  assert.equal(page2.pending.cursor, null);
});

test("Case 13: Coverage and future-timestamp data error flagging", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792687770000);

  // Set coverage key to full
  await r("SET", coordCoverageKey("fleet"), "full");

  // Insert an item with a future timestamp (e.g. now + 2 hours)
  const futureId = computeItemId("fleet", "handoff", "trail-future", "codex");
  await createCoordItem(store, {
    id: futureId,
    type: "handoff",
    request_trail: "trail-future",
    from: "agent:claude-code",
    to: "agent:codex",
    where: "job:job-future",
    summary: "Future item",
    created_at: now() + 2 * 3600 * 1000,
  });

  const res = await auditView(store, r, "fleet", {}, now());
  assert.equal(res.coverage, "full");

  // Future item must be sorted out of pending items and flagged under data_errors
  assert.equal(res.pending.items.length, 0);
  const futureErr = res.data_errors.find((e) => e.type === "future_timestamp" && e.id === futureId);
  assert.ok(futureErr, "Future timestamp item must appear in data_errors");
});

test("Case 2: Pure reads stay write-free for buildView with what=audit", async () => {
  const r = createMemoryRedis();
  const store = createStore(r, { space: "fleet" });
  const now = clock(1792687770000);

  // Populate an item
  const itemId = computeItemId("fleet", "handoff", "trail-1", "codex");
  await createCoordItem(store, {
    id: itemId,
    type: "handoff",
    request_trail: "trail-1",
    from: "agent:claude-code",
    to: "agent:codex",
    where: "job:job-1",
    summary: "Handoff 1",
    created_at: now(),
  });

  // Track writes to memory-redis
  const WRITES = new Set([
    "SET", "DEL", "HSET", "HDEL", "HINCRBY", "ZADD", "ZREM", "SADD", "SREM", "EVAL"
  ]);

  let writeCount = 0;
  const originalCall = r;
  const wrappedRedis = async (cmd, ...args) => {
    if (WRITES.has(String(cmd).toUpperCase())) {
      writeCount++;
    }
    return originalCall(cmd, ...args);
  };

  const viewResult = await buildView(wrappedRedis, "fleet", "audit", {}, now());
  assert.ok(viewResult.pending);
  assert.ok(viewResult.history);
  assert.equal(writeCount, 0, "Audit view must perform zero write commands to Redis");
});

test('audit reads backfill hash coverage without GET WRONGTYPE', async () => {
  const r = createMemoryRedis(), store = createStore(r, {space:'fleet'});
  await r('HSET', coordCoverageKey('fleet'), 'status', 'complete');
  const d = await auditView(store, r, 'fleet');
  assert.equal(d.coverage, 'full');
});

test('partial audit includes old handoffs without inventing index records or reviving settlements', async () => {
  const r = createMemoryRedis(), store = createStore(r, {space:'fleet'});
  const now = Date.now();
  await store.setWho('agent','codex',{name:'Codex'});
  for (const trail of ['waiting','accepted','indexed','completed']) await store.append('agent','codex', {
    ts:now-2*86400000,kind:'handoff',by:'agent:hermes',to:'agent:codex',trail,job:'job:review',summary:trail
  });
  await store.setNow('job','review',{stage:'done',handoff_trail:'completed'});
  await store.append('agent','codex',{ts:now-86400000,kind:'accepted',by:'agent:codex',origin:'accepted',trail:'ack'});
  await createCoordItem(store,{type:'handoff',request_trail:'indexed',from:'agent:hermes',to:'codex',where:'job:review',summary:'indexed',created_at:now-2*86400000});
  const id=computeItemId('fleet','handoff','indexed','codex');
  await settleCoordItem(store,{id,recipient:'codex',settledBy:'agent:codex'});
  const d=await auditView(store,r,'fleet',{},now);
  assert.equal(d.pending.total,1);
  assert.equal(d.pending.items[0].request_trail,'waiting');
  assert.equal(d.pending.items[0].read_only,true);
  assert.equal(d.pending.counts.overdue,1);
  assert.equal(await getCoordItem(store,'fleet',computeItemId('fleet','handoff','waiting','codex')),null);
});
