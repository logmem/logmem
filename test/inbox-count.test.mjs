// inbox-count.test.mjs: write responses carry the caller's unanswered-handoff count.
// Job logmem-inbox-surfacing-20261119. A long session only saw handoffs_to_me at
// start or Brief, so handoffs that arrived mid-run went unanswered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { computeItemId, coordItemKey, coordAgentOpenKey } from "../src/core/coord.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1792687770000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

async function fixture() {
  const redis = createMemoryRedis();
  const clk = clock();
  const mk = (sid) => createLogmem({ workRules: "warn", redis, space: "madez", surface: "test", sessionId: sid, now: clk });
  const atlas = mk("atlas-sid");
  const quill = mk("quill-sid");
  await sc(atlas, "logmem_start", { agent: "atlas" });
  await sc(quill, "logmem_start", { agent: "quill" });
  return { atlas, quill, clk };
}

test("inbox: 13 handoffs that arrive mid-session show on each of 10 writes", async () => {
  const { atlas, quill } = await fixture();
  for (let i = 0; i < 13; i++) {
    const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: `Task ${i}`, where: "channel:agent-coordination" });
    assert.equal(ho.ok, true);
  }
  const writes = (job) => [
    ["logmem_note", { where: "channel:agent-coordination", kind: "progress", summary: "Step one." }],
    ["logmem_assign", { job, title: "Job A" }],
    ["logmem_update", { job, summary: "Found the cause." }],
    ["logmem_stage", { job, stage: "active" }],
    ["logmem_status", { now: { doing: "Working on job A" } }],
  ];
  let seen = 0;
  for (let round = 0; round < 2; round++) {
    for (const [name, args] of writes(`inbox-${round}`)) {
      const r = await sc(quill, name, args);
      assert.equal(r.ok, true, `${name} ok`);
      assert.equal(r.inbox?.handoffs_waiting, 13, `${name} reports 13 waiting`);
      assert.equal(r.inbox.overdue, 0);
      assert.match(r.inbox.next, /logmem_accept/);
      seen++;
    }
  }
  assert.equal(seen, 10);
});

test("inbox: the count drops after accept and decline, and reads 0 with no next", async () => {
  const { atlas, quill } = await fixture();
  const a = await sc(atlas, "logmem_handoff", { to: "quill", summary: "One", where: "channel:agent-coordination" });
  const b = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Two", where: "channel:agent-coordination" });
  let r = await sc(quill, "logmem_note", { where: "channel:agent-coordination", summary: "Hi." });
  assert.equal(r.inbox.handoffs_waiting, 2);
  await sc(quill, "logmem_accept", { trail: a.trail });
  r = await sc(quill, "logmem_note", { where: "channel:agent-coordination", summary: "Took one." });
  assert.equal(r.inbox.handoffs_waiting, 1);
  await sc(quill, "logmem_accept", { trail: b.trail, decline: true, reason: "Not mine." });
  r = await sc(quill, "logmem_note", { where: "channel:agent-coordination", summary: "Clear." });
  assert.deepEqual(r.inbox, { handoffs_waiting: 0, overdue: 0 });
});

test("inbox: an accepted handoff whose coord item stayed open is not counted", async () => {
  const { atlas, quill } = await fixture();
  const store = quill.ctx.store;
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Stuck item", where: "channel:agent-coordination" });
  await sc(quill, "logmem_accept", { trail: ho.trail });
  // Simulate the live failure: the accept entry exists, but the settle never landed.
  const id = computeItemId("madez", "handoff", ho.trail, "quill");
  await store.redis("HSET", coordItemKey("madez", id), "response", "open");
  await store.redis("ZADD", coordAgentOpenKey("madez", "quill"), String(Date.now()), id);
  const r = await sc(quill, "logmem_note", { where: "channel:agent-coordination", summary: "Check." });
  assert.equal(r.inbox.handoffs_waiting, 0);
  const brief = await sc(quill, "logmem_brief", {});
  assert.equal(brief.handoffs_to_me.length, 0, "Brief agrees with the write count");
});

test("inbox: a refused write carries no inbox field, and reads never do", async () => {
  const { atlas, quill } = await fixture();
  await sc(atlas, "logmem_handoff", { to: "quill", summary: "One", where: "channel:agent-coordination" });
  const bad = await sc(quill, "logmem_status", { agent: "atlas", now: { doing: "Not mine to set" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.inbox, undefined);
  const roster = await sc(quill, "logmem_roster", {});
  assert.equal(roster.inbox, undefined);
});
