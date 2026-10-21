// The jail runs LogMem's own jail-safe Lua scripts and nothing else (managed users in the web app).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createJail, JailError } from "../src/http/jail.mjs";
import { registerEvalScript, jailSafeScripts } from "../src/lib/lua-scripts.mjs";
import { UNBLOCK_LUA } from "../src/http/work.mjs";

const T = "uabcdefghij";
const P = `lm:t-${T}:`;
function spy() {
  const base = createMemoryRedis();
  const calls = [];
  const r = async (...c) => { calls.push(c); return base(...c); };
  r.calls = calls;
  return r;
}
// A server-side script that is registered but NOT jail-safe (like the meter).
const SERVER_ONLY = "return redis.call('GET', KEYS[1])";
registerEvalScript(SERVER_ONLY, (call, keys) => call("GET", keys[0]));

test("jail scripts: a jail-safe LogMem script runs with keys inside the space", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  await j("HSET", `${P}job:j1:now`, "stage", '"active"');
  // Not blocked: the script answers without writing, and it ran through the jail.
  const res = await j("EVAL", UNBLOCK_LUA, 2, `${P}job:j1:now`, `${P}job:j1:unblock_pending`, "", "", "", "1", "{}");
  assert.equal(res, "not_blocked");
  assert.equal(redis.calls.at(-1)[0], "EVAL");
  assert.equal(await j("eval", UNBLOCK_LUA, "2", `${P}job:j1:now`, `${P}job:j1:unblock_pending`, "", "", "", "1", "{}"), "not_blocked", "case of the command name does not matter");
});

test("jail scripts: unknown, server-only and edited scripts are refused before Redis", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  for (const src of ["return 1", SERVER_ONLY, UNBLOCK_LUA + " ", UNBLOCK_LUA.replace("HSET", "DEL")]) {
    await assert.rejects(() => j("EVAL", src, 1, `${P}a`), JailError);
  }
  await assert.rejects(() => j("EVALSHA", "abc", 1, `${P}a`), JailError);
  await assert.rejects(() => j("SCRIPT", "LOAD", UNBLOCK_LUA), JailError);
  assert.equal(redis.calls.length, 0);
});

test("jail scripts: every key must be inside the space; numkeys is checked", async () => {
  const redis = spy();
  const j = createJail(redis, T);
  const pend = `${P}job:j1:unblock_pending`;
  await assert.rejects(() => j("EVAL", UNBLOCK_LUA, 2, `${P}job:j1:now`, "lm:madez:job:j1:unblock_pending", "", "", "", "1", "{}"), JailError);
  await assert.rejects(() => j("EVAL", UNBLOCK_LUA, 2, "lm:t-uother12345:job:j1:now", pend, "", "", "", "1", "{}"), JailError);
  // A key hidden in ARGV by under-counting numkeys is still never a key the script uses (scripts read KEYS only),
  // but numkeys 0, negative, too large or not a number is refused.
  for (const n of [0, -1, 99, "x", "1.5"]) await assert.rejects(() => j("EVAL", UNBLOCK_LUA, n, `${P}a`, pend), JailError, String(n));
  assert.equal(redis.calls.length, 0);
});

test("jail scripts: each jail-safe script touches only its KEYS (pins the safety rule)", () => {
  const scripts = jailSafeScripts();
  assert.ok(scripts.includes(UNBLOCK_LUA));
  for (const src of scripts) {
    const calls = [...src.matchAll(/redis\.call\(\s*'([A-Za-z]+)'\s*,\s*([^,)]+)/g)];
    assert.ok(calls.length > 0, "script has redis.call");
    for (const [, cmd, key] of calls) assert.match(key.trim(), /^KEYS\[\d+\]$/, `${cmd} must use a KEYS entry, got ${key}`);
    assert.doesNotMatch(src, /redis\.(pcall|setresp|replicate_commands)|loadstring|\bload\(|dofile|\bKEYS\[\s*[a-z_]/, "no dynamic calls or computed key indexes");
  }
});

test("jail scripts: a managed user's Unblock works end to end through the jail", async () => {
  const { createLogmem } = await import("../src/server.mjs");
  const { createStore } = await import("../src/core/store.mjs");
  const { unblock } = await import("../src/http/work.mjs");
  const base = createMemoryRedis();
  const jail = createJail(base, T);
  const lm = createLogmem({ redis: jail, space: jail.space, sessionId: "s", surface: "web", defaultAgent: "quill" });
  await lm.callTool("logmem_assign", { job: "j1", title: "Job one" });
  await lm.callTool("logmem_stage", { job: "j1", stage: "blocked", blocked_on: { type: "external", note: "Vendor outage" } });
  const store = createStore(jail, { space: jail.space });
  const out = await unblock(store, { job: "j1", note: "vendor is back", by: "human:test-user" });
  assert.equal(out.job?.stage ?? out.now?.stage ?? (await store.getNow("job", "j1")).stage, "active");
  assert.equal((await store.getNow("job", "j1")).stage, "active");
});
