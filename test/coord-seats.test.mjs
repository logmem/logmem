// coord-seats.test.mjs — Test suite for PR C: Directed Requests, Huddle Seats, and Roundtable Closers.
//
// Validates Acceptance Cases:
// - Case 15: Explicit `to` on huddle note creates one coordination seat per recipient
// - Case 16: Answering notes with `answers: <item id>` CAS settles the seat
// - Case 17: Roundtable close requires all seats answered
// - Probe 28: Two huddle recipients: one reply closes one seat and leaves the other pending
// - Recipient unclear: loose mentions without `to` do not create obligations

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { computeItemId, getCoordItem, coordAgentOpenKey, coordTrailKey } from "../src/core/coord.mjs";
import { huddleView } from "../src/http/view.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1792687770000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

async function createTeamFixture({ now } = {}) {
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
  const bentley = mk("bentley", "bentley-sid");

  await sc(atlas, "logmem_start", { agent: "atlas" });
  await sc(quill, "logmem_start", { agent: "quill" });
  await sc(bentley, "logmem_start", { agent: "bentley" });

  return { redis, atlas, quill, bentley, clock: clk };
}

test("Case 15: Explicit `to` on huddle creates one seat per recipient", async () => {
  const { atlas, quill, bentley } = await createTeamFixture();
  const store = atlas.ctx.store;

  const res = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "huddle",
    summary: "Coordination sync on launch readiness",
    to: ["quill", "bentley"],
  });
  assert.equal(res.ok, true);
  assert.ok(res.items);
  assert.equal(res.items.length, 2, "creates 2 coordination items");

  const quillItemId = computeItemId("madez", "seat", res.entry.trail, "quill");
  const bentleyItemId = computeItemId("madez", "seat", res.entry.trail, "bentley");

  assert.ok(res.items.includes(quillItemId));
  assert.ok(res.items.includes(bentleyItemId));

  const qItem = await getCoordItem(store, "madez", quillItemId);
  assert.equal(qItem.response, "open");
  assert.equal(qItem.type, "seat");
  assert.equal(qItem.to, "agent:quill");

  const bItem = await getCoordItem(store, "madez", bentleyItemId);
  assert.equal(bItem.response, "open");
  assert.equal(bItem.type, "seat");
  assert.equal(bItem.to, "agent:bentley");
});

test("Probe 28: Two huddle recipients: one reply closes one seat and leaves the other pending", async () => {
  const { atlas, quill, bentley, clock: clk } = await createTeamFixture();
  const store = atlas.ctx.store;

  // Atlas starts huddle with Quill and Bentley
  const huddle = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "huddle",
    summary: "Review security audit results",
    to: ["quill", "bentley"],
  });

  const quillItemId = computeItemId("madez", "seat", huddle.entry.trail, "quill");
  const bentleyItemId = computeItemId("madez", "seat", huddle.entry.trail, "bentley");

  // Quill replies answering their seat
  clk.advance(5000);
  const qReply = await sc(quill, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "memo",
    summary: "Quill reviewed: 0 vulnerabilities found",
    origin: huddle.entry.trail,
    answers: quillItemId,
    disposition: "answered",
  });
  assert.equal(qReply.ok, true);
  assert.equal(qReply.answered_item, quillItemId);

  // Quill's seat is answered and unindexed
  const qItem = await getCoordItem(store, "madez", quillItemId);
  assert.equal(qItem.response, "answered");
  assert.equal(qItem.settled_by, "agent:quill");

  const qOpen = await store.redis("ZRANGE", coordAgentOpenKey("madez", "quill"), 0, -1);
  assert.equal(qOpen.includes(quillItemId), false, "Quill seat removed from open index");

  // Bentley's seat remains open!
  const bItem = await getCoordItem(store, "madez", bentleyItemId);
  assert.equal(bItem.response, "open", "Bentley seat remains pending");

  const bOpen = await store.redis("ZRANGE", coordAgentOpenKey("madez", "bentley"), 0, -1);
  assert.equal(bOpen.includes(bentleyItemId), true, "Bentley seat still in open index");

  // Huddle view reflects exactly 1 answered, 1 pending
  const view = await huddleView(store, huddle.entry.trail, "channel:agent-coordination");
  assert.equal(view.participants.length, 2);
  const qPart = view.participants.find((p) => p.agent === "quill");
  const bPart = view.participants.find((p) => p.agent === "bentley");
  assert.equal(qPart.status, "acked");
  assert.equal(bPart.status, "pending");
});

test("Case 17: Roundtable close requires all seats answered", async () => {
  const { atlas, quill, bentley, clock: clk } = await createTeamFixture();

  // Atlas opens roundtable huddle
  const roundtable = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "huddle",
    summary: "Roundtable on telemetry parity",
    to: ["quill", "bentley"],
    payload: { roundtable: true },
  });

  const quillItemId = computeItemId("madez", "seat", roundtable.entry.trail, "quill");
  const bentleyItemId = computeItemId("madez", "seat", roundtable.entry.trail, "bentley");

  // Attempting to close while seats are open is refused
  const earlyClose = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "done",
    summary: "Closing roundtable prematurely",
    origin: roundtable.entry.trail,
  });
  assert.equal(earlyClose.ok, false);
  assert.match(earlyClose.error, /has 2 open seat\(s\) pending response/);

  // Quill answers
  clk.advance(2000);
  await sc(quill, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "memo",
    summary: "Quill telemetry confirmed",
    origin: roundtable.entry.trail,
    answers: quillItemId,
  });

  // Still 1 open seat: closing still refused
  const midClose = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "done",
    summary: "Closing with 1 seat remaining",
    origin: roundtable.entry.trail,
  });
  assert.equal(midClose.ok, false);
  assert.match(midClose.error, /has 1 open seat\(s\) pending response/);

  // Bentley answers
  clk.advance(2000);
  await sc(bentley, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "memo",
    summary: "Bentley telemetry confirmed",
    origin: roundtable.entry.trail,
    answers: bentleyItemId,
  });

  // Now all seats answered: closing succeeds!
  clk.advance(2000);
  const finalClose = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "done",
    summary: "Roundtable complete. Action items assigned.",
    origin: roundtable.entry.trail,
  });
  assert.equal(finalClose.ok, true);
  assert.equal(finalClose.entry.kind, "done");
});

test("Recipient unclear: @mentions without explicit `to` create no obligations", async () => {
  const { atlas, quill, bentley } = await createTeamFixture();
  const store = atlas.ctx.store;

  // Huddle with loose @mentions but NO `to` array
  const mentionHuddle = await sc(atlas, "logmem_note", {
    where: "channel:agent-coordination",
    kind: "huddle",
    summary: "Informational ping to @quill and @bentley and @fleet",
  });
  assert.equal(mentionHuddle.ok, true);
  assert.equal(mentionHuddle.items, undefined, "no coordination items created");

  // Huddle view shows them as recipient_unclear, not formal obligations
  const view = await huddleView(store, mentionHuddle.entry.trail, "channel:agent-coordination");
  assert.ok(view.recipient_unclear);
  assert.ok(view.recipient_unclear.includes("quill"));
  assert.ok(view.recipient_unclear.includes("bentley"));
  assert.equal(view.recipient_unclear.includes("fleet"), false, "@fleet is excluded");
});
