// Write responses carry the caller's open Inbox count (job logmem-inbox-surfacing-20261119).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { COORD_DEADLINE_MS } from "../src/core/coord.mjs";

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

test("a long session sees handoffs that arrive mid-run on every write, before its next start", async () => {
  const { atlas, quill, clk } = await fixture();
  const first = await sc(quill, "logmem_note", { where: "channel:general", summary: "Quill starts work." });
  assert.deepEqual(first.inbox, { open: 0, overdue: 0 });

  const trails = [];
  for (let i = 0; i < 13; i++) {
    const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: `Task ${i}`, where: `job:task-${i}` });
    assert.equal(ho.ok, true);
    trails.push(ho.trail);
  }

  for (let i = 0; i < 10; i++) {
    const out = await sc(quill, "logmem_note", { where: "channel:general", summary: `Quill entry ${i}.` });
    assert.equal(out.ok, true);
    assert.equal(out.inbox.open, 13, `entry ${i} reports 13 open items`);
    assert.equal(out.inbox.overdue, 0);
    assert.match(out.inbox.hint, /13 open Inbox items/);
  }

  const upd = await sc(quill, "logmem_update", { job: "task-0", summary: "Read the task." });
  assert.equal(upd.inbox.open, 13);
  const st = await sc(quill, "logmem_stage", { job: "task-0", stage: "active" });
  assert.equal(st.inbox.open, 13);
  const now = await sc(quill, "logmem_status", { now: { doing: "task 0" } });
  assert.equal(now.inbox.open, 13);

  await sc(quill, "logmem_accept", { trail: trails[0] });
  clk.advance(COORD_DEADLINE_MS + 1000);
  const late = await sc(quill, "logmem_note", { where: "channel:general", summary: "Later entry." });
  assert.deepEqual({ open: late.inbox.open, overdue: late.inbox.overdue }, { open: 12, overdue: 12 });
  assert.match(late.inbox.hint, /\(12 overdue\)/);
});

test("refused writes and reads carry no inbox field", async () => {
  const { quill } = await fixture();
  const bad = await sc(quill, "logmem_note", { where: "channel:general", summary: "x", kind: "decided" });
  assert.equal(bad.ok, false);
  assert.equal(bad.inbox, undefined);
  const brief = await sc(quill, "logmem_jobs", {});
  assert.equal(brief.inbox, undefined);
});
