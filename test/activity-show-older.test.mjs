// activity-show-older.test.mjs: the Activity "Show older" button pages back through the
// activity index with next_cursor. Job activity-index-feed, follow-up to PR 303.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendOlder, olderCursor, entryKey } from "../public/app/log-model.js";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { buildView } from "../src/http/view.mjs";

const e = (trail, ts, by = "agent:atlas", kind = "memo") => ({ trail, ts, by, kind, summary: trail });

test("appendOlder adds the older page once and keeps newest first", () => {
  const now = [e("c", 30), e("b", 20)];
  const older = [e("b", 20), e("a", 10)];
  const out = appendOlder(now, older);
  assert.deepEqual(out.map((x) => x.trail), ["c", "b", "a"]);
  assert.equal(new Set(out.map(entryKey)).size, out.length);
  assert.deepEqual(appendOlder(null, undefined), []);
});

test("olderCursor pages only an index reply that says more exists", () => {
  assert.equal(olderCursor({ coverage: { source: "index" }, next_cursor: "1792687768999" }), "1792687768999");
  assert.equal(olderCursor({ coverage: { source: "index" }, next_cursor: null }), null);
  assert.equal(olderCursor({ coverage: { source: "scan", partial: true }, next_cursor: "5" }), null);
  assert.equal(olderCursor({}), null);
});

test("Show older walks the whole index with no repeat or gap", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "madez", now: () => 1792687770000 });
  for (let i = 0; i < 450; i++) await store.append("channel", "c", { ts: 1792687000000 + i, kind: "memo", summary: `Note ${i}.`, by: "agent:atlas", trail: `t${i}` });
  const view = (params) => buildView(redis, "madez", "log", params, 1792687770000, { secret: "s".repeat(48) });
  let reply = await view({});
  let list = reply.entries;
  let cursor = olderCursor(reply);
  let clicks = 0;
  while (cursor && clicks < 10) {
    reply = await view({ cursor });
    list = appendOlder(list, reply.entries);
    cursor = olderCursor(reply);
    clicks++;
  }
  const notes = list.filter((x) => /^Note \d+\.$/.test(x.summary || ""));
  assert.equal(notes.length, 450);
  assert.equal(notes[0].summary, "Note 449.");
  assert.equal(notes.at(-1).summary, "Note 0.");
  assert.equal(clicks, 2);
});

test("the Activity view wires the button to the cursor", () => {
  const src = readFileSync(new URL("../public/app/views.js", import.meta.url), "utf8");
  assert.match(src, /load\('log', \{ cursor: live\.logNext \}\)/);
  assert.match(src, /Show older/);
  assert.match(src, /live\.logNext = olderCursor\(d\)/);
});
