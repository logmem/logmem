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
  listCoordItemsForTrail,
  listOpenCoordItemsForAgent,
  COORD_DEADLINE_MS,
  coordOpenKey,
  coordAgentOpenKey,
  COORD_SETTLE_ITEM_LUA,
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

// A settle that throws must not leave the item open for good. Live case
// (madez, 2026-11-20): five accepts in 23 seconds; two settled, two items
// stayed open because the settle error was swallowed after the entries landed.
async function flakySettleFixture(failures) {
  const redis = createMemoryRedis();
  const clk = clock();
  let left = failures;
  const flaky = async (...cmd) => {
    if (cmd[0] === "EVAL" && cmd[1] === COORD_SETTLE_ITEM_LUA && left > 0) {
      left--;
      throw new Error("Redis REST EVAL: HTTP 429");
    }
    return redis(...cmd);
  };
  const mk = (agent, r) => createLogmem({ workRules: "warn", redis: r, space: "madez", surface: "test", sessionId: `${agent}-sid`, now: clk });
  const atlas = mk("atlas", redis);
  const quill = mk("quill", flaky);
  await sc(atlas, "logmem_start", { agent: "atlas" });
  await sc(quill, "logmem_start", { agent: "quill" });
  return { atlas, quill, store: atlas.ctx.store, clk, failuresLeft: () => left };
}

test("accept: one thrown settle is retried and the item settles", async () => {
  const { atlas, quill, store } = await flakySettleFixture(1);
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Do A", where: "job:a" });
  const acc = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(acc.ok, true);
  assert.equal(acc.item_status, "ok");
  assert.equal(acc.warning, undefined);
  assert.equal((await getCoordItem(store, "madez", acc.item_id)).response, "answered");
});

test("accept: a settle that fails twice warns, and a second accept repairs the open item", async () => {
  const { atlas, quill, store } = await flakySettleFixture(2);
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Do A", where: "job:a" });
  const acc = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(acc.ok, true, "the entry is written, so the accept itself succeeds");
  assert.equal(acc.item_status, "error");
  assert.match(acc.warning, /Call logmem_accept again/);
  assert.equal((await getCoordItem(store, "madez", acc.item_id)).response, "open");
  assert.equal((await listOpenCoordItemsForAgent(store, "madez", "quill")).length, 1);

  const again = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(again.ok, true);
  assert.equal(again.repaired, true);
  assert.equal(again.trail, acc.trail, "repair points at the entry already written, not a new one");
  const item = await getCoordItem(store, "madez", acc.item_id);
  assert.equal(item.response, "answered");
  assert.equal(item.settlement_trail, acc.trail);
  assert.equal((await listOpenCoordItemsForAgent(store, "madez", "quill")).length, 0);
  const accepted = (await store.readLog("agent", "quill")).filter((e) => e.kind === "accepted");
  assert.equal(accepted.length, 1, "repair writes no second entry");

  const third = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(third.ok, false);
  assert.match(third.error, /already accepted/);
  assert.equal(third.item_status, "already_settled");
});

test("accept: a repaired decline settles as declined with its reason", async () => {
  const { atlas, quill, store } = await flakySettleFixture(2);
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Do B", where: "job:b" });
  const dec = await sc(quill, "logmem_accept", { trail: ho.trail, decline: true, reason: "Delivered already" });
  assert.equal(dec.item_status, "error");
  const again = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(again.ok, true);
  assert.equal(again.repaired, true);
  assert.equal(again.declined, true);
  const item = await getCoordItem(store, "madez", dec.item_id);
  assert.equal(item.response, "declined");
  assert.equal(item.disposition, "Delivered already");
});

// A handoff stays owed to its recipient however long ago it was made. The
// Brief used to read only the newest 200 entries and logmem_accept only the
// newest 500, so an old handoff could be listed and yet be impossible to
// accept ("no handoff with trail '...' was passed to <agent>"). Both reads
// now cover the whole log.
//
// The handoff here is written straight to the agent's log, with no
// coordination item, because that is the shape that broke: with no index row
// there is nothing for the coord-index fallback to look up, so a windowed
// read was the only thing that could find the handoff at all.
test("accept: a handoff older than the old read windows is still in the Brief and still acceptable", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;
  const t0 = clk();

  await store.append("agent", "quill", {
    kind: "handoff",
    summary: "Old open work",
    trail: "old-open-trail",
    to: "agent:quill",
    by: "agent:atlas",
    ts: t0,
  });

  // Push the handoff past both old read windows (200 for the Brief, 500 for
  // the accept lookup) with later entries on Quill's own log.
  for (let i = 0; i < 550; i++) {
    await store.append("agent", "quill", {
      kind: "memo",
      summary: `filler ${i}`,
      trail: `filler-${i}`,
      by: "agent:quill",
      ts: t0 + 100 + i,
    });
  }
  const total = (await store.readLog("agent", "quill")).length;
  assert.ok(total > 500, `the handoff is now ${total} entries back, past both old windows`);
  // No index row exists for this trail, so the coord-index fallback has
  // nothing to fall back to.
  assert.deepEqual(await listCoordItemsForTrail(store, "madez", "old-open-trail"), []);

  // The handoff must still be visible in the Brief.
  const brief = await sc(quill, "logmem_brief", {});
  const waiting = (brief.handoffs_to_me || []).find((h) => h.trail === "old-open-trail");
  assert.ok(waiting, "a handoff older than the old read window stays in the Brief");
  assert.equal((brief.do_next || []).some((d) => d.ref === "old-open-trail"), true, "and it is still offered as the next thing to do");

  // And it must still be actionable.
  const acc = await sc(quill, "logmem_accept", { trail: "old-open-trail" });
  assert.equal(acc.ok, true, `logmem_accept finds a handoff older than 500 entries: ${acc.error || ""}`);
  assert.equal(acc.origin, "old-open-trail");
  const accepted = (await store.readLog("agent", "quill")).filter((e) => e.kind === "accepted" && e.origin === "old-open-trail");
  assert.equal(accepted.length, 1, "the acceptance is written on the recipient's own log");

  // Once accepted it leaves the Brief again.
  const after = await sc(quill, "logmem_brief", {});
  assert.equal((after.handoffs_to_me || []).some((h) => h.trail === "old-open-trail"), false, "the settled handoff drops out of the Brief");
});

// The same read window must not let one recipient take another recipient's
// part, and must not stop a recipient taking their own part.
test("accept: an old multi-recipient handoff settles only the caller's own part", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;
  const t0 = clk();

  // One handoff, two recipients, a copy on each agent's own log. This is the
  // shape that must still split: Atlas may take Atlas's part, never Quill's.
  const entry = {
    kind: "handoff",
    summary: "Split the work",
    trail: "old-split-trail",
    to: ["agent:atlas", "agent:quill"],
    by: "agent:grok",
    ts: t0,
  };
  await store.append("agent", "atlas", entry);
  await store.append("agent", "quill", entry);

  for (let i = 0; i < 550; i++) {
    await store.append("agent", "atlas", {
      kind: "memo",
      summary: `filler ${i}`,
      trail: `filler-${i}`,
      by: "agent:atlas",
      ts: t0 + 100 + i,
    });
  }

  // Atlas takes Atlas's part. The handoff is found however old it is.
  const acc = await sc(atlas, "logmem_accept", { trail: "old-split-trail" });
  assert.equal(acc.ok, true, `logmem_accept finds an old multi-recipient handoff: ${acc.error || ""}`);
  assert.equal(
    (await store.readLog("agent", "atlas")).some((e) => e.kind === "accepted" && e.origin === "old-split-trail"),
    true,
    "the acceptance lands on the accepting agent's own log",
  );
  assert.equal(
    (await store.readLog("agent", "quill")).some((e) => e.kind === "accepted" && e.origin === "old-split-trail"),
    false,
    "the other recipient's part is not settled by this acceptance",
  );

  // Quill's part is still open and still Quill's to take.
  const quillBrief = await sc(quill, "logmem_brief", {});
  assert.equal((quillBrief.handoffs_to_me || []).some((h) => h.trail === "old-split-trail"), true, "Quill's part is still waiting");
  const quillAcc = await sc(quill, "logmem_accept", { trail: "old-split-trail" });
  assert.equal(quillAcc.ok, true, `Quill can still take her own part: ${quillAcc.error || ""}`);
});

// A handoff addressed only to somebody else is still refused, however old it
// is: the unlimited read finds the copy on the caller's own log, and the
// recipient check still turns it away.
test("accept: an old handoff addressed to someone else is still refused", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;
  const t0 = clk();

  // A copy on Atlas's own log and on the shared job, both addressed to Quill.
  const entry = {
    kind: "handoff",
    summary: "Quill's work",
    trail: "old-quills-trail",
    to: "agent:quill",
    by: "agent:grok",
    ts: t0,
  };
  await store.append("agent", "atlas", entry);
  await store.append("job", "quills-work", entry);

  for (let i = 0; i < 550; i++) {
    await store.append("agent", "atlas", {
      kind: "memo",
      summary: `filler ${i}`,
      trail: `filler-${i}`,
      by: "agent:atlas",
      ts: t0 + 100 + i,
    });
  }

  const acc = await sc(atlas, "logmem_accept", { trail: "old-quills-trail" });
  assert.equal(acc.ok, false, "a handoff passed to Quill cannot be accepted by Atlas");
  assert.match(acc.error, /was passed to atlas/);
  assert.equal(
    (await store.readLog("agent", "quill")).some((e) => e.kind === "accepted" && e.origin === "old-quills-trail"),
    false,
    "nothing is written to the addressed recipient's log",
  );
});

// The coord-index fallback must keep working: when the handoff copy lives
// only on the shared job log, the per-recipient coordination item points at
// it, and that is how the accept path finds it.
test("accept: a handoff that lives only on the shared job log is still found through the coordination item", async () => {
  const { atlas, quill, clock: clk } = await createFixture();
  const store = atlas.ctx.store;
  const t0 = clk();

  // The handoff is on the job log only. Quill's own log never saw it.
  await store.append("job", "shared-job", {
    kind: "handoff",
    summary: "Work that lives on the job",
    trail: "job-only-trail",
    to: "agent:quill",
    by: "agent:grok",
    ts: t0,
  });
  await createCoordItem(store, {
    space: "madez",
    type: "handoff",
    requestTrail: "job-only-trail",
    from: "agent:grok",
    to: "agent:quill",
    where: "job:shared-job",
    summary: "Work that lives on the job",
    createdAt: t0,
  });

  // Push the job log past the old 500-entry window too.
  for (let i = 0; i < 550; i++) {
    await store.append("job", "shared-job", {
      kind: "memo",
      summary: `filler ${i}`,
      trail: `filler-${i}`,
      by: "agent:grok",
      ts: t0 + 100 + i,
    });
  }

  const acc = await sc(quill, "logmem_accept", { trail: "job-only-trail" });
  assert.equal(acc.ok, true, `the coordination item points at the handoff on the job log: ${acc.error || ""}`);
  assert.equal(acc.origin, "job-only-trail");
  assert.equal((await getCoordItem(store, "madez", acc.item_id)).response, "answered");
});
