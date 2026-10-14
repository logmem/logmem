// Ops baseline: Redis timeouts + retry, native timeout, health check,
// structured logs, version string, stdio degraded mode. All offline: fetch is
// mocked, backends are in-memory or fakes.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRedis, redis as instanceRedis, READ_COMMANDS, redisTimeoutMs } from "../src/lib/redis-rest.mjs";
import { withTimeout, nativeTimeoutMs, evictIfDead } from "../src/lib/redis-native.mjs";
import { resilientBackendFromEnv, BackendRequiredError, requireBackendFromEnv } from "../src/lib/backend.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem, versionString, SERVER_INFO } from "../src/server.mjs";
import { healthCheck, createHandler } from "../api/health.mjs";
import { requestRecord, logRequest } from "../src/http/log.mjs";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const URL_ = "https://bridge.example.test/bridge/exec";
const TOKEN = "s3cret-token-value";
const realFetch = globalThis.fetch;
const realTimeout = process.env.LOGMEM_REDIS_TIMEOUT_MS;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realTimeout === undefined) delete process.env.LOGMEM_REDIS_TIMEOUT_MS;
  else process.env.LOGMEM_REDIS_TIMEOUT_MS = realTimeout;
});

const ok = (result) => new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });

/** fetch that never answers until its signal aborts (i.e. a hung bridge). */
function hangingFetch(calls) {
  return (url, init) => {
    calls.push({ url, init });
    return new Promise((_, reject) => {
      // AbortSignal.timeout does not ref the event loop, so the test runner
      // would cancel the test before the abort fired. This timer only keeps
      // the loop awake; the abort still decides when the fetch fails.
      const hold = setTimeout(() => {}, 120000);
      const fail = () => {
        clearTimeout(hold);
        reject(init.signal.reason);
      };
      if (init.signal.aborted) fail();
      else init.signal.addEventListener("abort", fail, { once: true });
    });
  };
}

function assertNoSecrets(e) {
  assert.ok(!e.message.includes(TOKEN), "error leaks token");
  assert.ok(!e.message.includes("bridge.example.test"), "error leaks URL");
}

test("REST: every fetch carries an AbortSignal; timeout budget comes from LOGMEM_REDIS_TIMEOUT_MS", async () => {
  assert.equal(redisTimeoutMs({}), 5000);
  assert.equal(redisTimeoutMs({ LOGMEM_REDIS_TIMEOUT_MS: "1200" }), 1200);
  assert.equal(redisTimeoutMs({ LOGMEM_REDIS_TIMEOUT_MS: "nope" }), 5000);
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return ok("PONG"); };
  const r = createRedis({ url: URL_, token: TOKEN });
  assert.equal(await r("PING"), "PONG");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.body, JSON.stringify(["PING"]));
});

test("REST: a hung read times out, is retried exactly once, then fails naming the command only", async () => {
  process.env.LOGMEM_REDIS_TIMEOUT_MS = "40";
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  const r = createRedis({ url: URL_, token: TOKEN });
  const t0 = Date.now();
  await assert.rejects(r("GET", "k"), (e) => {
    assert.match(e.message, /Redis REST GET: timed out after 40ms/);
    assertNoSecrets(e);
    return true;
  });
  assert.equal(calls.length, 2, "read retried once");
  assert.ok(Date.now() - t0 >= 40 * 2 + 200 - 5, "jittered pause (>=200ms) between attempts");
});

test("REST: a hung write times out and is never retried", async () => {
  process.env.LOGMEM_REDIS_TIMEOUT_MS = "40";
  for (const cmd of [["LPUSH", "k", "v"], ["ZADD", "z", "1", "m"], ["SET", "k", "v"], ["INCR", "n"], ["HSET", "h", "f", "v"]]) {
    const calls = [];
    globalThis.fetch = hangingFetch(calls);
    const r = createRedis({ url: URL_, token: TOKEN });
    await assert.rejects(r(...cmd), (e) => {
      assert.match(e.message, new RegExp(`Redis REST ${cmd[0]}: timed out`));
      assertNoSecrets(e);
      return true;
    });
    assert.equal(calls.length, 1, `${cmd[0]} must not be retried`);
  }
});

test("REST: a read that fails transiently once succeeds on the retry", async () => {
  let n = 0;
  globalThis.fetch = async () => (++n === 1 ? new Response("bad gateway", { status: 502 }) : ok(["a", "b"]));
  const r = createRedis({ url: URL_, token: TOKEN });
  assert.deepEqual(await r("lrange", "k", "0", "-1"), ["a", "b"], "lower-case read commands count as reads");
  assert.equal(n, 2);
});

test("REST: network errors retry reads; 4xx and Redis errors never retry", async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    const cause = Object.assign(new Error(`connect ECONNREFUSED bridge.example.test:443 ${TOKEN}`), { code: "ECONNREFUSED" });
    throw new TypeError(`fetch failed for ${URL_}`, { cause });
  };
  const r = createRedis({ url: URL_, token: TOKEN });
  await assert.rejects(r("HGETALL", "h"), (e) => {
    assert.match(e.message, /^Redis REST HGETALL: network error \(ECONNREFUSED\)$/);
    assertNoSecrets(e);
    return true;
  });
  assert.equal(n, 2);

  n = 0;
  globalThis.fetch = async () => { n++; return new Response("nope", { status: 401 }); };
  await assert.rejects(r("GET", "k"), /Redis REST GET: HTTP 401/);
  assert.equal(n, 1, "auth failures are not transient");

  n = 0;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: "WRONGTYPE" }), { status: 200 }); };
  await assert.rejects(r("GET", "k"), /Redis REST GET: WRONGTYPE/);
  assert.equal(n, 1);

  n = 0;
  globalThis.fetch = async () => {
    n++;
    return new Response(JSON.stringify({ error: `NOAUTH ${URL_} Bearer ${TOKEN} token=${TOKEN}` }), { status: 200 });
  };
  await assert.rejects(r("GET", "k"), (e) => {
    assert.match(e.message, /^Redis REST GET: /);
    assertNoSecrets(e);
    assert.ok(!e.message.includes("https://"), "upstream data.error URL is not passed through");
    return true;
  });
  assert.equal(n, 1, "Redis errors are not retried");

  n = 0;
  globalThis.fetch = async () => { n++; return new Response("busy", { status: 503 }); };
  await assert.rejects(r("DEL", "k"), /Redis REST DEL: HTTP 503/);
  assert.equal(n, 1, "writes are not retried even on 5xx");
});

test("REST: instance-based redis() shares the same timeout path", async () => {
  process.env.LOGMEM_REDIS_TIMEOUT_MS = "30";
  const calls = [];
  globalThis.fetch = hangingFetch(calls);
  await assert.rejects(instanceRedis({ id: "default", url: URL_, token: TOKEN }, "SADD", "s", "m"), /SADD: timed out after 30ms/);
  assert.equal(calls.length, 1);
});

test("REST: read command list matches the ops contract", () => {
  assert.deepEqual([...READ_COMMANDS].sort(), ["DBSIZE", "EXISTS", "GET", "HGET", "HGETALL", "HMGET", "LLEN", "LRANGE", "PING", "SCAN", "SMEMBERS", "TTL", "TYPE", "ZCARD", "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZSCORE"]);
  assert.equal(READ_COMMANDS.has("KEYS"), false);
});

test("native: per-command timeout via Promise.race with the same budget", async () => {
  assert.equal(nativeTimeoutMs({}), 5000);
  assert.equal(nativeTimeoutMs({ LOGMEM_REDIS_TIMEOUT_MS: "250" }), 250);
  let evicted = false;
  await assert.rejects(withTimeout(new Promise(() => {}), 30, "ZADD", () => { evicted = true; }), /native redis ZADD: timed out after 30ms/);
  assert.equal(evicted, true, "timed-out client is evicted");
  assert.equal(await withTimeout(Promise.resolve("PONG"), 30, "PING"), "PONG");
});

function fakeClient({ open = true, ready = true } = {}) {
  return { isOpen: open, isReady: ready, disconnects: 0, async disconnect() { this.disconnects++; this.isOpen = false; } };
}
const tick = () => new Promise((r) => setImmediate(r));

test("native: a timeout on an old client never evicts or disconnects a newer cached client", async () => {
  const uri = "redis://cache.test:6379";
  const oldClient = fakeClient({ open: false, ready: false }); // dead socket
  const oldPending = Promise.resolve(oldClient);
  const newClient = fakeClient();
  const newPending = Promise.resolve(newClient);
  const cache = new Map([[uri, newPending]]); // someone already reconnected
  assert.equal(evictIfDead(uri, { pending: oldPending, client: oldClient }, cache), false);
  await tick();
  assert.equal(cache.get(uri), newPending, "newer entry kept");
  assert.equal(newClient.disconnects, 0, "newer client not disconnected");
});

test("native: a slow command on a healthy shared client does not evict it; a dead socket does", async () => {
  const uri = "redis://cache.test:6379";
  const healthy = fakeClient();
  const pending = Promise.resolve(healthy);
  const cache = new Map([[uri, pending]]);
  assert.equal(evictIfDead(uri, { pending, client: healthy }, cache), false, "slow but open+ready");
  await tick();
  assert.equal(cache.get(uri), pending);
  assert.equal(healthy.disconnects, 0);

  healthy.isReady = false; // socket dropped
  assert.equal(evictIfDead(uri, { pending, client: healthy }, cache), true);
  await tick();
  assert.equal(cache.has(uri), false);
  assert.equal(healthy.disconnects, 1);

  const hung = new Promise(() => {}); // connect never finished
  cache.set(uri, hung);
  assert.equal(evictIfDead(uri, { pending: hung, client: undefined }, cache), true);
  assert.equal(cache.has(uri), false);
});

test("health: happy path returns ok, version, commit, redis_ms, region with no secrets", async () => {
  const env = { VERCEL_GIT_COMMIT_SHA: "abcdef1234567890", VERCEL_REGION: "iad1", LOGMEM_REST_URL: URL_, LOGMEM_REST_TOKEN: TOKEN };
  let t = 100;
  const { status, body } = await healthCheck({
    env,
    resolve: () => ({ kind: "rest", redis: async (c) => { t += 7; return c === "PING" ? "PONG" : null; } }),
    clock: () => t,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, version: pkg.version, commit: "abcdef1", region: "iad1", redis_ms: 7 });
  assert.ok(!JSON.stringify(body).includes(TOKEN) && !JSON.stringify(body).includes("example.test"));
});

test("health: failure, timeout and missing config all return 503 ok:false without raw errors", async () => {
  const env = {};
  const down = await healthCheck({ env, resolve: () => ({ kind: "rest", redis: async () => { throw new Error(`connect ECONNREFUSED ${URL_} ${TOKEN}`); } }) });
  assert.equal(down.status, 503);
  assert.equal(down.body.ok, false);
  assert.equal(down.body.error, "backend unreachable");
  assert.ok(!JSON.stringify(down.body).includes(TOKEN) && !JSON.stringify(down.body).includes("example.test"));

  const slow = await healthCheck({ env, timeoutMs: 20, resolve: () => ({ kind: "native", redis: () => new Promise(() => {}) }) });
  assert.equal(slow.status, 503);
  assert.match(slow.body.error, /timed out after 20ms/);

  const none = await healthCheck({ env, resolve: () => null });
  assert.equal(none.status, 503);
  assert.equal(none.body.error, "backend not configured");
  assert.equal(none.body.commit, null);
});

function fakeRes() {
  return {
    headers: {}, code: 0, payload: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.payload = b; return this; },
  };
}

test("health handler: no-store, status codes, 405 for writes, one JSON log line per request", async () => {
  const lines = [];
  const log = { sink: (l) => lines.push(JSON.parse(l)) };
  const up = createHandler({ env: {}, resolve: () => ({ kind: "memory", redis: createMemoryRedis() }), log });
  const res = fakeRes();
  await up({ method: "GET" }, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.payload.ok, true);

  const down = createHandler({ env: {}, resolve: () => ({ kind: "rest", redis: async () => { throw new Error("x"); } }), log });
  const res2 = fakeRes();
  await down({ method: "GET" }, res2);
  assert.equal(res2.code, 503);
  assert.equal(res2.headers["cache-control"], "no-store");

  const res3 = fakeRes();
  await up({ method: "POST" }, res3);
  assert.equal(res3.code, 405);

  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => [l.route, l.method, l.status, l.ok, l.level]), [
    ["/api/health", "GET", 200, true, "info"],
    ["/api/health", "GET", 503, false, "error"],
    ["/api/health", "POST", 405, false, "error"],
  ]);
  assert.ok(lines.every((l) => typeof l.ms === "number" && typeof l.ts === "string"));
});

test("log: requestRecord drops undefined fields and trims errors; logRequest never throws", () => {
  const rec = requestRecord({ route: "/api/mcp", method: "POST", tool: "logmem_write", ms: 12.6, ok: true, status: 200 }, () => new Date(0));
  assert.deepEqual(rec, { ts: "1970-01-01T00:00:00.000Z", level: "info", route: "/api/mcp", method: "POST", tool: "logmem_write", ms: 13, ok: true, status: 200 });
  const big = requestRecord({ ok: false, err: new Error("x".repeat(1000)) });
  assert.equal(big.level, "error");
  assert.ok(big.err.length < 320);
  assert.doesNotThrow(() => logRequest({ route: "/x" }, { sink: () => { throw new Error("boom"); } }));
});

test("version: package.json version plus short Vercel commit SHA; name stays logmem", () => {
  assert.equal(SERVER_INFO.name, "logmem");
  assert.equal(versionString({}), pkg.version);
  assert.equal(versionString({ VERCEL_GIT_COMMIT_SHA: "0123456789abcdef" }), `${pkg.version}+0123456`);
  assert.equal(versionString({ VERCEL_GIT_COMMIT_SHA: "  " }), pkg.version);
  if (!process.env.VERCEL_GIT_COMMIT_SHA) assert.equal(SERVER_INFO.version, pkg.version);
});

test("degraded: LOGMEM_REQUIRE_BACKEND=1 refuses to start without a reachable backend", async () => {
  assert.equal(requireBackendFromEnv({ LOGMEM_REQUIRE_BACKEND: "1" }), true);
  assert.equal(requireBackendFromEnv({}), false);
  await assert.rejects(resilientBackendFromEnv({ LOGMEM_REQUIRE_BACKEND: "1" }, () => {}, { resolve: () => null }), BackendRequiredError);
  await assert.rejects(
    resilientBackendFromEnv({ LOGMEM_REQUIRE_BACKEND: "1" }, () => {}, { resolve: () => ({ kind: "rest", redis: async () => { throw new Error("down"); } }) }),
    (e) => e instanceof BackendRequiredError && /refusing to start/.test(e.message),
  );
  const up = await resilientBackendFromEnv({ LOGMEM_REQUIRE_BACKEND: "1" }, () => {}, { resolve: () => ({ kind: "rest", redis: createMemoryRedis() }) });
  assert.equal(up.kind, "rest");
  assert.equal(up.degraded(), false);
  up.stop();
});

test("degraded: memory fallback marks every tool result, re-probe switches to the real backend", async () => {
  let alive = false;
  const real = createMemoryRedis();
  const configured = { kind: "rest", redis: async (...cmd) => { if (!alive) throw new Error("down"); return real(...cmd); } };
  const logs = [];
  const b = await resilientBackendFromEnv({}, (m) => logs.push(m), { resolve: () => configured, reprobeMs: 0 });
  assert.equal(b.kind, "memory");
  assert.equal(b.degraded(), true);
  assert.match(logs[0], /NOT durable/);

  const lm = createLogmem({ live: b, space: "opsdeg", sessionId: "s1", defaultAgent: "agent:test" });
  const conn = await lm.callTool("logmem_connection", {});
  assert.equal(conn.structuredContent.degraded, true);
  assert.equal(conn.structuredContent.backend, "memory");
  const unknown = await lm.callTool("no_such_tool", {});
  assert.equal(unknown.structuredContent.degraded, true);
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /"degraded": true/);

  assert.equal(await b.probeNow(), false, "still down");
  alive = true;
  assert.equal(await b.probeNow(), true, "back up");
  assert.equal(b.kind, "rest");
  assert.equal(b.degraded(), false);
  assert.match(logs.at(-1), /switched over/);

  const after = await lm.callTool("logmem_connection", {});
  assert.equal(after.structuredContent.backend, "rest");
  assert.equal(after.structuredContent.degraded, false);
  assert.equal(after.structuredContent.ping, "PONG");
  b.stop();
});

test("degraded: bad backend config degrades instead of crashing; probes are single-flight", async () => {
  const logs = [];
  const bad = await resilientBackendFromEnv({}, (m) => logs.push(m), { resolve: () => { throw new Error("Invalid URL"); }, reprobeMs: 0 });
  assert.equal(bad.kind, "memory");
  assert.match(logs[0], /backend config invalid \(Invalid URL\)/);
  await assert.rejects(
    resilientBackendFromEnv({ LOGMEM_REQUIRE_BACKEND: "1" }, () => {}, { resolve: () => { throw new Error("Invalid URL"); } }),
    BackendRequiredError,
  );

  let pings = 0;
  let alive = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  const b = await resilientBackendFromEnv({}, () => {}, {
    reprobeMs: 0,
    resolve: () => ({ kind: "rest", redis: async () => { pings++; if (!alive) throw new Error("down"); await gate; return "PONG"; } }),
  });
  assert.equal(pings, 1);
  alive = true;
  const p1 = b.probeNow();
  const p2 = b.probeNow();
  assert.equal(p1, p2, "second probe joins the in-flight one");
  release();
  assert.deepEqual(await Promise.all([p1, p2]), [true, true]);
  assert.equal(pings, 2, "only one PING for two concurrent probes");
  assert.equal(b.kind, "rest");
});

test("degraded: one tool call uses one backend snapshot even if the backend switches mid-call", async () => {
  const mem = { kind: "memory", redis: createMemoryRedis(), seen: 0 };
  const realStore = createMemoryRedis();
  const real = { kind: "rest", redis: realStore, seen: 0 };
  let active = mem;
  const count = (h) => async (...cmd) => {
    h.seen++;
    if (h === mem && mem.seen === 2) active = real; // backend comes back mid-call
    return h === mem ? mem.redis(...cmd) : realStore(...cmd);
  };
  const live = { current: () => (active === mem ? { kind: "memory", redis: count(mem) } : { kind: "rest", redis: count(real) }) };
  const lm = createLogmem({ live, space: "opssnap", sessionId: "s3", defaultAgent: "agent:test" });

  const first = await lm.callTool("logmem_note", { where: "channel:ops", summary: "written while degraded" });
  assert.equal(first.structuredContent.ok, true, JSON.stringify(first.structuredContent));
  assert.ok(mem.seen > 2, "the call kept issuing commands after the switch");
  assert.equal(real.seen, 0, "no command of the first call reached the real backend");
  assert.equal(first.structuredContent.degraded, true);
  assert.equal(active, real);

  const before = real.seen;
  const memBefore = mem.seen;
  const second = await lm.callTool("logmem_connection", {});
  assert.ok(real.seen > before, "next call uses the real backend");
  assert.equal(mem.seen, memBefore, "and never touches memory");
  assert.equal(second.structuredContent.backend, "rest");
  assert.equal(second.structuredContent.degraded, false);
});

test("degraded: results without a live backend are unchanged", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), backend: "rest", space: "opsplain", sessionId: "s2" });
  const r = await lm.callTool("logmem_connection", {});
  assert.equal(r.structuredContent.degraded, false);
  assert.equal(r.structuredContent.backend, "rest");
});
