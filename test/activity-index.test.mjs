// activity-index.test.mjs: the per-space activity index behind /api/view?what=log.
// Job activity-index-feed. The old view scanned up to 300 logs and read 100 entries
// from each, so a busy space showed an incomplete window with no way to page back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "./space-context.mjs";
import { createStore } from "../src/core/store.mjs";
import { buildView } from "../src/http/view.mjs";
import { activityKey, trimActivity, activityPage } from "../src/core/activity.mjs";

const SECRET = { secret: "s".repeat(48) };
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
  return { redis, atlas, quill, clk };
}

const view = (redis, params, clk) => buildView(redis, "madez", "log", params, clk(), SECRET);

test("activity: 450 notes page back in full, newest first, with no repeat and no gap", async () => {
  const { redis, atlas, clk } = await fixture();
  for (let i = 0; i < 450; i++) {
    clk.advance(1);
    const r = await sc(atlas, "logmem_note", { where: "channel:agent-coordination", summary: `Note ${i}.` });
    assert.equal(r.ok, true);
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const v = await view(redis, cursor ? { cursor } : {}, clk);
    assert.equal(v.coverage.source, "index");
    seen.push(...v.entries);
    cursor = v.next_cursor;
    pages++;
    if (!cursor) {
      assert.equal(v.coverage.end, true);
      assert.match(v.coverage.note, /older than the oldest indexed/);
    }
  } while (cursor && pages < 10);
  const notes = seen.filter((e) => /^Note \d+\.$/.test(e.summary || ""));
  assert.equal(notes.length, 450, "every note is listed once");
  assert.equal(new Set(notes.map((e) => e.summary)).size, 450);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i - 1].ts >= seen[i].ts, "newest first");
  assert.equal(notes[0].summary, "Note 449.");
  assert.equal(notes[0].where, "channel:agent-coordination");
  assert.equal(pages, 3);
});

test("activity: a handoff written to several logs shows once, where the work lives", async () => {
  const { redis, atlas, quill, clk } = await fixture();
  for (let i = 0; i < 5; i++) {
    clk.advance(1);
    await sc(atlas, "logmem_note", { where: "channel:agent-coordination", summary: `Warm ${i}.` });
  }
  clk.advance(1);
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Take the review.", where: "channel:agent-coordination" });
  assert.equal(ho.ok, true);
  const v = await view(redis, { limit: 3 }, clk);
  assert.equal(v.coverage.source, "index");
  const rows = v.entries.filter((e) => e.trail === ho.trail);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].where, "channel:agent-coordination");
  void quill;
});

test("activity: a page never splits one millisecond", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "madez", now: () => 1792687770000 });
  for (let i = 0; i < 4; i++) await store.append("channel", "c", { ts: 1792687760000 + i, kind: "memo", summary: `Old ${i}.`, by: "agent:atlas" });
  for (let i = 0; i < 5; i++) await store.append("channel", "c", { ts: 1792687769000, kind: "memo", summary: `Same ${i}.`, by: "agent:atlas" });
  const p1 = await activityPage(redis, "madez", { limit: 3 });
  assert.equal(p1.rows.length, 5, "all five rows at one ms stay together");
  assert.equal(p1.next_cursor, String(1792687769000 - 1));
  const p2 = await activityPage(redis, "madez", { limit: 3, cursor: Number(p1.next_cursor) });
  assert.deepEqual(p2.rows.map((r) => r.summary), ["Old 3.", "Old 2.", "Old 1."]);
  const p3 = await activityPage(redis, "madez", { limit: 3, cursor: Number(p2.next_cursor) });
  assert.deepEqual(p3.rows.map((r) => r.summary), ["Old 0."]);
  assert.equal(p3.next_cursor, null);
});

test("activity: a young index falls back to the scan and says so", async () => {
  const { redis, atlas, clk } = await fixture();
  clk.advance(1);
  await sc(atlas, "logmem_note", { where: "channel:agent-coordination", summary: "Only one." });
  const v = await view(redis, {}, clk);
  assert.equal(v.coverage.source, "scan");
  assert.equal(v.coverage.partial, true);
  assert.ok(v.entries.some((e) => e.summary === "Only one."));
  // An empty index (a space written before this change) also uses the scan.
  await redis("DEL", activityKey("madez"));
  assert.equal((await view(redis, {}, clk)).coverage.source, "scan");
});

test("activity: removing an entry removes its row, and trim keeps the newest", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "madez", now: () => 1792687770000 });
  const kept = [];
  for (let i = 0; i < 6; i++) kept.push(await store.append("job", "j", { ts: 1792687760000 + i, kind: "progress", summary: `Step ${i}.`, by: "agent:atlas" }));
  assert.equal(await redis("ZCARD", activityKey("madez")), 6);
  assert.equal(await store.removeEntry("job", "j", kept[5]), 1);
  assert.equal(await redis("ZCARD", activityKey("madez")), 5);
  assert.equal(await trimActivity(redis, "madez", 3), 2);
  const p = await activityPage(redis, "madez", { limit: 10 });
  assert.deepEqual(p.rows.map((r) => r.summary), ["Step 4.", "Step 3.", "Step 2."]);
  assert.equal(p.oldest, 1792687760002);
});

test("activity: a bad cursor is refused, and the view stays read only", async () => {
  const { redis, clk } = await fixture();
  await assert.rejects(view(redis, { cursor: "abc" }, clk), (e) => e.code === "bad_cursor");
  await assert.rejects(view(redis, { cursor: "-5" }, clk), (e) => e.code === "bad_cursor");
  const before = await redis("ZCARD", activityKey("madez"));
  await view(redis, {}, clk);
  assert.equal(await redis("ZCARD", activityKey("madez")), before);
});
