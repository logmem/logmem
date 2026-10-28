import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { computeItemId, getCoordItem, coordCoverageKey, listOpenCoordItemsForAgent } from "../src/core/coord.mjs";
import { runCoordBackfill } from "../scripts/coord-backfill.mjs";

const space = "backfill-test";
const ts = 1792687770000;
function fixture() {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space });
  const run = (options = {}) => runCoordBackfill({ store, space, quiet: true, ...options });
  return { store, redis, run };
}
const handoff = (trail, to = "agent:quill") => ({ kind: "handoff", trail, to, by: "agent:atlas", summary: "Review change", ts });

test("backfill scans older entries beyond the previous 1,000-entry cap", async () => {
  const { store, run } = fixture();
  await store.append("agent", "quill", handoff("old"));
  for (let i = 0; i < 1001; i++) await store.append("agent", "quill", { kind: "memo", trail: `n${i}`, summary: "Progress", ts: ts + i + 1 });
  const result = await run();
  assert.equal(result.status, "complete");
  assert.equal(result.totalScanned, 1002);
  assert.equal(result.itemsCreated, 1);
  assert.equal((await listOpenCoordItemsForAgent(store, space, "quill")).length, 1);
});

test("backfill scans jobs and channels and deduplicates mirrored requests", async () => {
  const { store, run } = fixture();
  await store.append("job", "release", handoff("shared"));
  await store.append("agent", "quill", handoff("shared"));
  await store.append("channel", "team", { kind: "huddle", trail: "review", to: ["agent:quill", "agent:atlas"], by: "agent:muse", summary: "Review", ts });
  await store.append("job", "release", { kind: "request", trail: "request", to: "agent:muse", by: "agent:atlas", summary: "Check", ts });
  const result = await run();
  assert.equal(result.status, "complete");
  assert.equal(result.itemsCreated, 4);
  assert.equal((await getCoordItem(store, space, computeItemId(space, "handoff", "shared", "quill"))).where, "job:release");
  assert.equal((await run()).itemsCreated, 0);
});

test("backfill reconciles settlement from a different source and rejects other authors", async () => {
  const { store, run } = fixture();
  await store.append("job", "release", handoff("settled"));
  await store.append("channel", "team", { kind: "accepted", origin: "settled", trail: "wrong", by: "agent:atlas", ts: ts + 1 });
  await store.append("channel", "team", { kind: "feedback", origin: "settled", trail: "right", by: "agent:quill", payload: { declined: true, reason: "Superseded" }, ts: ts + 2 });
  const result = await run();
  assert.equal(result.itemsSettled, 1);
  const item = await getCoordItem(store, space, computeItemId(space, "handoff", "settled", "quill"));
  assert.equal(item.response, "declined");
  assert.equal(item.settlement_trail, "right");
  assert.equal((await listOpenCoordItemsForAgent(store, space, "quill")).length, 0);
  assert.equal((await run()).itemsSettled, 0);
});

test("bounded reads remain partial and clear an older complete marker", async () => {
  const { store, redis, run } = fixture();
  await store.append("agent", "quill", handoff("first"));
  await store.append("agent", "quill", handoff("second"));
  await run();
  const result = await run({ limit: 1 });
  assert.equal(result.status, "partial");
  assert.match(result.warnings[0], /Read limit/);
  assert.equal(await redis("HGET", coordCoverageKey(space), "status"), "partial");
  assert.equal(await redis("HGET", coordCoverageKey(space), "completed_at"), "");
});

test("dry run performs no Redis writes, including reset or settlement", async () => {
  const { store, redis, run } = fixture();
  await store.append("job", "release", handoff("dry"));
  await store.append("agent", "quill", { kind: "accepted", origin: "dry", trail: "accepted", by: "agent:quill", ts: ts + 1 });
  store.redis = async (...args) => {
    assert.ok(["HGETALL", "GET", "TYPE", "SCAN"].includes(args[0]), `Unexpected write ${args[0]}`);
    return redis(...args);
  };
  const result = await run({ dry: true, reset: true });
  assert.equal(result.status, "complete");
  assert.equal(result.itemsCreated, 1);
  assert.equal(result.itemsSettled, 1);
  assert.equal(await redis("EXISTS", coordCoverageKey(space)), 0);
  assert.equal(await getCoordItem(store, space, computeItemId(space, "handoff", "dry", "quill")), null);
});

test("read failures persist an error marker instead of completing coverage", async () => {
  const { store, redis, run } = fixture();
  store.list = async () => { throw new Error("Read unavailable"); };
  const result = await run();
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.equal(await redis("HGET", coordCoverageKey(space), "status"), "error");
  assert.equal(await redis("HGET", coordCoverageKey(space), "completed_at"), "");
});

test("ambiguous directed replies stay open and require verification", async () => {
  const { store, run } = fixture();
  await store.append("channel", "team", { kind: "huddle", trail: "review", to: "agent:quill", by: "agent:atlas", summary: "Review", ts });
  await store.append("channel", "team", { kind: "memo", origin: "review", trail: "reply", by: "agent:quill", summary: "Related note", ts: ts + 1 });
  const result = await run();
  assert.equal(result.status, "partial");
  assert.equal(result.itemsSettled, 0);
  assert.match(result.warnings[0], /settlement verification/);
});

test("explicit directed settlement evidence closes only its recipient seat", async () => {
  const { store, run } = fixture();
  const id = computeItemId(space, "seat", "review", "quill");
  await store.append("channel", "team", { kind: "huddle", trail: "review", to: ["agent:quill", "agent:muse"], by: "agent:atlas", summary: "Review", ts });
  await store.append("channel", "team", { kind: "memo", origin: "review", answers: id, trail: "reply", by: "agent:quill", summary: "Done", ts: ts + 1 });
  const result = await run();
  assert.equal(result.itemsSettled, 1);
  assert.equal(result.status, "complete");
  assert.equal((await listOpenCoordItemsForAgent(store, space, "muse")).length, 1);
});

test("backfill replaces the legacy string coverage marker", async () => {
  const { redis, run } = fixture();
  await redis("SET", coordCoverageKey(space), "full");
  assert.equal((await run()).status, "complete");
  assert.equal(await redis("HGET", coordCoverageKey(space), "status"), "complete");
});

test("source changes during a scan keep coverage partial", async () => {
  const { store, run } = fixture();
  await store.append("agent", "quill", handoff("moving"));
  const originalRead = store.readLog.bind(store);
  store.readLog = async (...args) => {
    const log = await originalRead(...args);
    await store.append("agent", "quill", handoff("concurrent"));
    return log;
  };
  const result = await run();
  assert.equal(result.status, "partial");
  assert.match(result.warnings[0], /changed during/);
});

test("unreadable source warnings prevent complete coverage", async () => {
  const { store, run } = fixture();
  await store.append("agent", "quill", handoff("warning"));
  const originalRead = store.readLog.bind(store);
  store.readLog = async (...args) => {
    const log = await originalRead(...args);
    Object.defineProperty(log, "warnings", { value: ["Unreadable legacy log"] });
    return log;
  };
  assert.equal((await run()).status, "partial");
});

test("source discovery indexes an orphan canonical log without a roster entry", async () => {
  const { store, redis, run } = fixture();
  await redis("ZADD", `lm:${space}:agent:unregistered:log`, ts, JSON.stringify(handoff("orphan", "agent:unregistered")));
  assert.deepEqual(await store.list("agent"), []);
  const result = await run();
  assert.equal(result.status, "complete");
  assert.equal(result.itemsCreated, 1);
  assert.equal((await listOpenCoordItemsForAgent(store, space, "unregistered")).length, 1);
});

test("source discovery reads unregistered legacy work and thread timelines with normalized timestamps", async () => {
  const { store, redis, run } = fixture();
  const old = { kind: "task-delegation", correlationId: "old-source", source: "agent:atlas", to: "agent:quill", timestamp: ts / 1000, summary: "Legacy request" };
  await redis("ZADD", `acmi:${space}:work:orphan-job:timeline`, ts / 1000, JSON.stringify(old));
  await redis("SET", `acmi:${space}:thread:orphan-channel:timeline`, JSON.stringify([{ kind: "handoff-ack", parentCorrelationId: "old-source", correlationId: "old-accept", source: "agent:quill", timestamp: (ts + 1000) / 1000 }]));
  const result = await run();
  assert.equal(result.status, "complete");
  assert.equal(result.itemsCreated, 1);
  assert.equal(result.itemsSettled, 1);
  const item = await getCoordItem(store, space, computeItemId(space, "handoff", "old-source", "quill"));
  assert.equal(item.created_at, ts);
  assert.equal(item.where, "job:orphan-job");
  assert.equal(item.response, "answered");
});

test("source discovery keeps legacy colon identifiers partial without writing unsafe item records", async () => {
  const { redis, run } = fixture();
  await redis("ZADD", `acmi:${space}:thread:channel:old:timeline`, ts, JSON.stringify(handoff("unsafe")));
  const result = await run();
  assert.equal(result.status, "partial");
  assert.equal(result.itemsCreated, 0);
  assert.match(result.warnings[0], /Unsafe source identifier/);
});

test("source discovery stays inside exact space boundaries and reads every scan page", async () => {
  const { store, redis, run } = fixture();
  const ownKey = `lm:${space}:channel:orphan:log`;
  const foreignKey = `lm:${space}-other:agent:foreign:log`;
  await redis("ZADD", ownKey, ts, JSON.stringify(handoff("own")));
  await redis("ZADD", foreignKey, ts, JSON.stringify(handoff("foreign")));
  const calls = [];
  store.redis = async (...args) => {
    if (args[0] === "SCAN" && args[3] === `lm:${space}:*`) {
      calls.push(args[1]);
      return args[1] === "0" ? ["7", [foreignKey]] : ["0", [ownKey]];
    }
    return redis(...args);
  };
  const result = await run();
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["0", "7"]);
  assert.equal(result.itemsCreated, 1);
  assert.equal(await getCoordItem(store, space, computeItemId(space, "handoff", "foreign", "quill")), null);
});

test("unreadable orphan legacy timelines keep coverage partial", async () => {
  const { redis, run } = fixture();
  await redis("HSET", `acmi:${space}:agent:orphan:timeline`, "bad", "data");
  const result = await run();
  assert.equal(result.status, "partial");
  assert.match(result.warnings[0], /Unreadable source entries/);
});

test("unsafe historical recipients stay partial and never create malformed indexes", async () => {
  const { redis, run } = fixture();
  await redis("ZADD", `lm:${space}:job:orphan:log`, ts, JSON.stringify(handoff("unsafe-recipient", "agent:foo:bar")));
  const result = await run();
  assert.equal(result.status, "partial");
  assert.equal(result.itemsCreated, 0);
  assert.match(result.warnings[0], /Unsafe recipient/);
  assert.equal(await redis("EXISTS", `lm:${space}:coord:open:foo:bar`), 0);
});
