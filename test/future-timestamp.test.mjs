// A writer with a broken clock stamped a codex entry 17841395696220 (year 2535). It sorted above
// every real entry on newest-first reads. Writes now refuse far-future stamps, and reads stop
// trusting them: the entry sorts as oldest and keeps its claimed stamp in ts_claimed.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore, FutureTimestampError, FUTURE_WRITE_MS } from "../src/core/store.mjs";
import { acmiKey } from "../src/core/keys.mjs";

const NOW = 1794933000000; // 2026-11-17
const BAD = 17841395696220; // the real stamp from the codex entry
const mk = (opts = {}) => {
  const redis = createMemoryRedis();
  return { redis, store: createStore(redis, { space: "t", now: () => NOW, ...opts }) };
};

test("a write more than a year ahead is refused with a reason", async () => {
  const { store } = mk();
  await assert.rejects(store.append("channel", "c", { kind: "memo", summary: "x", ts: BAD }), (e) => {
    assert.ok(e instanceof FutureTimestampError);
    assert.equal(e.code, "future_ts");
    assert.match(e.message, /in the future/);
    return true;
  });
  assert.equal((await store.readLog("channel", "c")).length, 0);
});

test("clock skew within the bound and no ts still write", async () => {
  const { store } = mk();
  await store.append("channel", "c", { kind: "memo", summary: "skew", ts: NOW + FUTURE_WRITE_MS - 1000 });
  const e = await store.append("channel", "c", { kind: "memo", summary: "server clock" });
  assert.equal(e.ts, NOW);
  assert.equal((await store.readLog("channel", "c")).length, 2);
});

test("a stored far-future entry no longer sorts first, and keeps its claimed stamp", async () => {
  const { redis, store } = mk();
  await redis("ZADD", "lm:t:channel:c:log", BAD, JSON.stringify({ kind: "memo", summary: "bad clock", ts: BAD }));
  await store.append("channel", "c", { kind: "memo", summary: "real", ts: NOW - 1000 });
  const newest = await store.readLog("channel", "c", { reverse: true });
  assert.equal(newest[0].summary, "real");
  const bad = newest.find((e) => e.summary === "bad clock");
  assert.equal(bad.ts, 0);
  assert.equal(bad.ts_claimed, BAD);
});

test("a far-future legacy ACMI entry drops out of a since window", async () => {
  const { redis, store } = mk({ compat: true });
  await redis("ZADD", acmiKey("t", "channel", "c", "log"), BAD, JSON.stringify({ kind: "milestone-pre", summary: "bad clock", ts: BAD }));
  await store.append("channel", "c", { kind: "memo", summary: "real", ts: NOW - 1000 });
  const recent = await store.readLog("channel", "c", { reverse: true, sinceMs: NOW - 3600000 });
  assert.deepEqual(recent.map((e) => e.summary), ["real"]);
  const all = await store.readLog("channel", "c", { reverse: true });
  assert.equal(all[0].summary, "real");
});
