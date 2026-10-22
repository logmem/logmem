// Plugin pilot server gaps, items 1 and 2 (spec 2026-10-20-logmem-agent-plugin-design.md, section 8).
// 1. On HTTP, a read-only tool writes nothing: no shift start, no last_seen bump, no mirror drain.
// 2. HTTP tools/call validates arguments with the same zod schemas the stdio SDK path uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { buildInstance, dispatch } from "../api/mcp.mjs";

const WRITES = new Set(["SET", "DEL", "HSET", "HDEL", "HINCRBY", "ZADD", "ZREM", "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK", "SADD", "SREM", "EXPIRE", "PEXPIRE", "LPUSH", "RPUSH", "LPOP", "RPOP", "LTRIM", "INCR", "INCRBY", "GETDEL", "RENAME", "EVAL", "EVALSHA", "XADD", "MULTI", "EXEC"]);

/** memory-redis that records every command. */
function spyRedis() {
  const base = createMemoryRedis();
  const calls = [];
  const r = async (cmd, ...args) => {
    calls.push([String(cmd).toUpperCase(), ...args]);
    return base(cmd, ...args);
  };
  r.calls = calls;
  return r;
}

const READ_CALLS = [
  ["logmem_brief", {}],
  ["logmem_roster", {}],
  ["logmem_jobs", {}],
  ["logmem_spaces", {}],
  ["logmem_connection", {}],
  ["logmem_feed", { refs: ["channel:ops"] }],
  ["logmem_view", { ref: "channel:ops" }],
  ["logmem_recall", { query: "deploy" }],
];

test("pure reads: every read tool runs with zero Redis writes and never drains the mirror", async () => {
  const redis = spyRedis();
  const lm = createLogmem({ redis, space: "acme", sessionId: "chatgpt.s1", surface: "chatgpt", defaultAgent: "chatgpt", pureReads: true, mirror: { enabled: true, spaces: ["acme"] } });
  for (const [name, args] of READ_CALLS) {
    redis.calls.length = 0;
    const out = (await lm.callTool(name, args)).structuredContent;
    assert.notEqual(out.ok, false, `${name}: ${out.error}`);
    assert.equal(out.shift_events, undefined, `${name} started no shift`);
    const writes = redis.calls.filter(([c]) => WRITES.has(c));
    assert.deepEqual(writes, [], `${name} wrote ${JSON.stringify(writes)}`);
    assert.ok(!redis.calls.some((c) => String(c[1]).endsWith(":mirror:retry")), `${name} touched the mirror queue`);
  }
});

test("pure reads: the Brief still defaults to this connection's agent, and the first write starts the shift", async () => {
  const redis = spyRedis();
  const lm = createLogmem({ redis, space: "acme", sessionId: "chatgpt.s2", surface: "chatgpt", lockedAgent: "chatgpt", pureReads: true });
  const brief = (await lm.callTool("logmem_brief", {})).structuredContent;
  assert.equal(brief.ok, true);
  assert.equal(brief.agent, "chatgpt");
  const note = (await lm.callTool("logmem_note", { where: "channel:ops", summary: "First write." })).structuredContent;
  assert.equal(note.ok, true);
  assert.deepEqual(note.shift_events.map((e) => e.type), ["auto-start"]);
  // An open shift is reused by later reads, without a write.
  redis.calls.length = 0;
  const again = (await lm.callTool("logmem_brief", {})).structuredContent;
  assert.equal(again.agent, "chatgpt");
  assert.deepEqual(redis.calls.filter(([c]) => WRITES.has(c)), []);
});

test("pure reads: off by default, so stdio keeps auto-start on any first call", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "acme", sessionId: "stdio.s3", surface: "stdio", defaultAgent: "quill" });
  const brief = (await lm.callTool("logmem_brief", {})).structuredContent;
  assert.deepEqual(brief.shift_events.map((e) => e.type), ["auto-start"]);
});

test("http: buildInstance serves pure reads", async () => {
  const redis = spyRedis();
  const auth = { space: "acme", source: "oauth", pinned: true, agent: null };
  const lmFactory = async () => buildInstance({ redis, kind: "memory", auth, sessionId: "chatgpt.s4", env: { LOGMEM_AGENT: "chatgpt" } });
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "logmem_brief", arguments: {} } }, { lmFactory, toolDefs: () => [] });
  assert.equal(r.result.structuredContent.ok, true);
  assert.deepEqual(redis.calls.filter(([c]) => WRITES.has(c)), []);
});

async function httpCall(name, args) {
  const redis = spyRedis();
  const auth = { space: "acme", source: "oauth", pinned: true, agent: null };
  const lmFactory = async () => buildInstance({ redis, kind: "memory", auth, sessionId: "chatgpt.s5", env: { LOGMEM_AGENT: "chatgpt" } });
  const r = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { lmFactory, toolDefs: () => [] });
  return { r: r.result, redis };
}

test("http validation: a wrong type, a missing field or a non-object is refused before anything runs", async () => {
  for (const [args, re] of [
    [{ where: "channel:ops", summary: 42 }, /summary/],
    [{ where: "channel:ops" }, /summary/],
    ["not an object", /object/],
    [[1, 2], /object/],
    [{ job: "x", stage: "flying" }, /stage/],
  ]) {
    const name = args && !Array.isArray(args) && args.job ? "logmem_stage" : "logmem_note";
    const { r, redis } = await httpCall(name, args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.structuredContent.error, /Invalid arguments/);
    assert.match(r.structuredContent.error, re);
    assert.deepEqual(redis.calls.filter(([c]) => WRITES.has(c)), [], "no shift, no entry");
  }
});

test("http validation: valid arguments pass, and unknown keys are stripped like the SDK path", async () => {
  const { r } = await httpCall("logmem_note", { where: "channel:ops", summary: "Deploy is ready.", sneaky: "x" });
  assert.equal(r.structuredContent.ok, true);
  assert.equal(r.structuredContent.entry.sneaky, undefined);
  const missing = await httpCall("logmem_brief", undefined);
  assert.equal(missing.r.structuredContent.ok, true, "absent arguments mean {}");
});
