// acmi-bridge (cloud slice B): jail, refusals, auth, limits, quota, logs, and
// redis-rest.mjs end to end through the bridge. In-memory Redis throughout.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createRedis } from "../src/lib/redis-rest.mjs";
import { probe } from "../scripts/bridge-probe.mjs";
import {
  createBridge, classify, keyArgs, checkCommand, tokenMatches, sha256Hex,
  COMMANDS, DENIED, DEFAULT_LIMITS, tenantPrefixes, genericRedisError, validateLimits, utcMonth,
} from "../cloud/bridge/bridge.mjs";
import { createRespRunner, createParser, encodeCommand, parseRedisUrl, BINARY_KEY, RespError } from "../cloud/bridge/resp.mjs";
import { selfTest, meterRunner, limitsFromEnv, meterRedisFromEnv } from "../cloud/bridge/main.mjs";
import { isServerRejection } from "../cloud/bridge/bridge.mjs";
import { translate } from "../src/lib/redis-native.mjs";
import * as sliceA from "../cloud/meter/index.mjs";

const TENANT = "acme";
const TOKEN = "acmi_bridge_test_token_0123456789abcdef";
const HASH = sha256Hex(TOKEN);
const K = (s) => `acmi:t-${TENANT}:${s}`;
const LK = (s) => `lm:t-${TENANT}:${s}`;

async function startBridge(opts = {}) {
  const redis = opts.redis ?? createMemoryRedis();
  const logs = [];
  const bridge = createBridge({
    tenant: TENANT,
    tokenSha256: HASH,
    redis,
    log: (l) => logs.push(l),
    ...opts,
  });
  const server = createServer(bridge.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, { token = TOKEN, method = "POST", headers = {}, raw } = {}) => {
    const h = { "Content-Type": "application/json", ...headers };
    if (token !== null) h.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers: h,
      body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  return {
    base, redis, logs, bridge,
    exec: (cmd, o) => call("/exec", cmd, o),
    pipe: (cmds, o) => call("/pipeline", cmds, o),
    call,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---- classification and key positions -------------------------------------------

describe("command table", () => {
  test("classify: add / read / null, case-insensitive", () => {
    assert.equal(classify(["GET", K("a")]), "read");
    assert.equal(classify(["get", K("a")]), "read");
    assert.equal(classify(["SeT", K("a"), "v"]), "add");
    assert.equal(classify(["DEL", K("a")]), "add");
    assert.equal(classify(["PING"]), "read");
    assert.equal(classify(["KEYS", "*"]), null);
    assert.equal(classify(["NOPE"]), null);
    assert.equal(classify([]), null);
    assert.equal(classify("GET"), null);
    assert.equal(classify([42]), null);
    assert.equal(classify(["__proto__"]), null);
    assert.equal(classify(["constructor"]), null);
  });

  test("keyArgs resolves single, multi, pair, numkeys and two-key commands", () => {
    assert.deepEqual(keyArgs(["GET", "k"]), ["k"]);
    assert.deepEqual(keyArgs(["SET", "k", "v", "NX", "EX", "60"]), ["k"]);
    assert.deepEqual(keyArgs(["DEL", "a", "b", "c"]), ["a", "b", "c"]);
    assert.deepEqual(keyArgs(["MGET", "a", "b"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["EXISTS", "a", "b"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["MSET", "a", "1", "b", "2"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["RENAME", "a", "b"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["SMOVE", "a", "b", "m"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["LMOVE", "a", "b", "LEFT", "RIGHT"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["SINTER", "a", "b"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["SUNIONSTORE", "d", "a", "b"]), ["d", "a", "b"]);
    assert.deepEqual(keyArgs(["ZUNIONSTORE", "d", "2", "a", "b", "WEIGHTS", "1", "2"]), ["d", "a", "b"]);
    assert.deepEqual(keyArgs(["ZINTERSTORE", "d", "2", "a", "b", "AGGREGATE", "MAX"]), ["d", "a", "b"]);
    assert.deepEqual(keyArgs(["ZUNION", "2", "a", "b", "WITHSCORES"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["COPY", "a", "b", "REPLACE"]), ["a", "b"]);
    assert.deepEqual(keyArgs(["PING"]), []);
    assert.deepEqual(keyArgs(["SCAN", "0"]), []);
    assert.deepEqual(keyArgs(["EVAL", "return 1", "1", "k"]), []);
  });

  test("malformed arity and numkeys are refused (no keys resolved)", () => {
    const p = { prefixes: tenantPrefixes(TENANT), maxValueBytes: 1024 };
    for (const cmd of [
      ["GET"],
      ["DEL"],
      ["RENAME", K("a")],
      ["MSET", K("a"), "1", K("b")],
      ["ZUNIONSTORE", K("d"), "x", K("a")],
      ["ZUNIONSTORE", K("d"), "0"],
      ["ZUNIONSTORE", K("d"), "3", K("a"), K("b")],
      // short numkeys trying to smuggle a third key in the tail
      ["ZUNIONSTORE", K("d"), "1", K("a"), "acmi:other:b"],
      ["ZINTERSTORE", K("d"), "2", K("a"), K("b"), "WEIGHTS", "1"],
      ["COPY", K("a"), K("b"), "DB", "1"],
    ]) {
      assert.equal(checkCommand(cmd, p).ok, false, JSON.stringify(cmd));
    }
  });

  test("every command the repo and bridge-probe send is in the table", () => {
    const used = [
      "PING", "GET", "SET", "DEL", "EXISTS", "TYPE", "EXPIRE", "TTL", "INCR", "DECR", "GETDEL",
      "SADD", "SREM", "SMEMBERS", "HSET", "HGET", "HGETALL", "HDEL", "HMGET",
      "LPUSH", "RPUSH", "LRANGE", "LLEN", "ZADD", "ZREM", "ZCARD", "ZSCORE", "ZRANGE",
      "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "SCAN",
    ];
    for (const c of used) assert.ok(Object.hasOwn(COMMANDS, c), c);
  });

  test("no command is both allowed and denied", () => {
    for (const c of DENIED) assert.ok(!Object.hasOwn(COMMANDS, c), c);
  });
});

// ---- HTTP surface -------------------------------------------------------------------

describe("acmi-bridge over HTTP", () => {
  let b;
  before(async () => { b = await startBridge(); });
  after(async () => { await b.close(); });

  test("GET /health: no auth, no data", async () => {
    const r = await b.call("/health", null, { method: "GET", token: null });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["ok", "tenant", "version"]);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.tenant, TENANT);
  });

  test("exec round trip on both tenant prefixes", async () => {
    assert.deepEqual((await b.exec(["SET", K("s"), "v1"])).body, { result: "OK" });
    assert.deepEqual((await b.exec(["GET", K("s")])).body, { result: "v1" });
    assert.deepEqual((await b.exec(["set", LK("s"), "v2"])).body, { result: "OK" });
    assert.deepEqual((await b.exec(["get", LK("s")])).body, { result: "v2" });
    assert.deepEqual((await b.exec(["PING"])).body, { result: "PONG" });
    assert.deepEqual((await b.call("/", ["GET", K("s")])).body, { result: "v1" }, "POST / is exec (Upstash shape)");
  });

  test("pipeline returns one {result}|{error} per command", async () => {
    const r = await b.pipe([["SET", K("p"), "1"], ["INCR", K("p")], ["GET", K("p")], ["SADD", K("p"), "x"]]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.slice(0, 3), [{ result: "OK" }, { result: 2 }, { result: "2" }]);
    assert.match(r.body[3].error, /^WRONGTYPE command failed$/);
  });

  test("unknown paths and wrong methods", async () => {
    assert.equal((await b.call("/nope", ["PING"])).status, 404);
    assert.equal((await b.call("/exec", null, { method: "GET" })).status, 405);
  });
});

// ---- jail escapes -----------------------------------------------------------------

describe("jail", () => {
  let b;
  before(async () => {
    b = await startBridge();
    // Plant other tenants' data straight into Redis.
    await b.redis("SET", "acmi:other:secret", "OTHER_SECRET_VALUE");
    await b.redis("SET", "lm:other:secret", "OTHER_SECRET_VALUE");
    await b.redis("SET", "acmi:t-acmex:secret", "PREFIX_TRICK_VALUE");
    await b.redis("SET", "acmi:t-acme", "BARE_VALUE");
    await b.redis("SET", "acmi:acme:legacy", "UNNAMESPACED_VALUE");
    await b.redis("SET", "acmi:t-other:secret", "OTHER_SECRET_VALUE");
    await b.redis("SET", "acmi:cloud:meter:acme:202610:add", "5");
    await b.redis("SET", K("mine"), "MINE");
  });
  after(async () => { await b.close(); });

  const forbidden = async (cmd) => {
    const r = await b.exec(cmd);
    assert.equal(r.status, 403, JSON.stringify(cmd));
    assert.deepEqual(r.body, { error: "forbidden" });
    return r;
  };

  test("other-tenant keys are refused on both prefixes", async () => {
    await forbidden(["GET", "acmi:other:secret"]);
    await forbidden(["GET", "lm:other:secret"]);
    await forbidden(["SET", "acmi:other:secret", "x"]);
    await forbidden(["GET", "acmi:cloud:meter:acme:202610:add"]);
    await forbidden(["INCR", "acmi:cloud:meter:acme:202610:add"]);
    await forbidden(["GET", "secret"]);
    await forbidden(["GET", "ACMI:acme:mine"]);
    assert.equal(await b.redis("GET", "acmi:other:secret"), "OTHER_SECRET_VALUE");
  });

  test("prefix trick acmi:{tenant}x: and the bare prefix are refused", async () => {
    await forbidden(["GET", "acmi:t-acmex:secret"]);
    await forbidden(["GET", "lm:t-acmex:secret"]);
    await forbidden(["GET", "acmi:t-acme"]);
    await forbidden(["GET", "acmi:t-acme:"]);
    await forbidden(["GET", "lm:t-acme:"]);
    await forbidden(["GET", " acmi:t-acme:mine"]);
  });

  test("un-namespaced acmi:{tenant}: / lm:{tenant}: keys are refused", async () => {
    await forbidden(["GET", "acmi:acme:legacy"]);
    await forbidden(["SET", "acmi:acme:x", "1"]);
    await forbidden(["GET", "lm:acme:x"]);
    await forbidden(["GET", "acmi:t-other:secret"]);
    await forbidden(["SCAN", "0", "MATCH", "acmi:acme:*"]);
  });

  test("keys hidden in later args", async () => {
    await forbidden(["DEL", K("mine"), "acmi:other:secret"]);
    await forbidden(["EXISTS", K("mine"), K("x"), "acmi:other:secret"]);
    await forbidden(["MGET", K("mine"), "acmi:other:secret"]);
    await forbidden(["MSET", K("a"), "1", "acmi:other:secret", "2"]);
    await forbidden(["TOUCH", K("a"), "lm:other:secret"]);
    assert.equal(await b.redis("GET", "acmi:other:secret"), "OTHER_SECRET_VALUE");
  });

  test("multi-key commands with one good and one bad key", async () => {
    await forbidden(["RENAME", K("mine"), "acmi:other:stolen"]);
    await forbidden(["RENAME", "acmi:other:secret", K("stolen")]);
    await forbidden(["RENAMENX", "acmi:other:secret", K("stolen")]);
    await forbidden(["COPY", "acmi:other:secret", K("stolen")]);
    await forbidden(["SMOVE", K("s"), "acmi:other:s", "m"]);
    await forbidden(["LMOVE", "acmi:other:l", K("l"), "LEFT", "RIGHT"]);
    await forbidden(["RPOPLPUSH", "acmi:other:l", K("l")]);
    await forbidden(["SINTER", K("s"), "acmi:other:s"]);
    await forbidden(["SUNIONSTORE", K("d"), K("s"), "acmi:other:s"]);
    await forbidden(["SDIFFSTORE", "acmi:other:d", K("s")]);
    await forbidden(["ZUNIONSTORE", K("d"), "2", K("z"), "acmi:other:z"]);
    await forbidden(["ZINTERSTORE", "acmi:other:d", "1", K("z")]);
    await forbidden(["ZDIFFSTORE", K("d"), "2", K("z"), "lm:other:z"]);
    await forbidden(["ZUNION", "2", K("z"), "acmi:other:z"]);
    await forbidden(["ZRANGESTORE", K("d"), "acmi:other:z", "0", "-1"]);
    assert.equal(await b.redis("GET", K("mine")), "MINE");
  });

  test("SCAN: MATCH forced to the tenant prefix, escapes refused", async () => {
    const r = await b.exec(["SCAN", "0"]);
    assert.equal(r.status, 200);
    const [, keys] = r.body.result;
    assert.ok(keys.length > 0);
    assert.ok(keys.every((k) => k.startsWith("acmi:t-acme:")), JSON.stringify(keys));

    const lm = await b.exec(["scan", "0", "match", `${LK("")}*`, "count", "10"]);
    assert.equal(lm.status, 200);
    assert.ok(lm.body.result[1].every((k) => k.startsWith("lm:t-acme:")));

    await forbidden(["SCAN", "0", "MATCH", "*"]);
    await forbidden(["SCAN", "0", "MATCH", "acmi:*"]);
    await forbidden(["SCAN", "0", "MATCH", "acmi:t-acme*"]); // would match acmi:t-acmex:
    await forbidden(["SCAN", "0", "MATCH", "acmi:other:*"]);
    await forbidden(["SCAN", "0", "MATCH", "*acmi:t-acme:*"]);
    await forbidden(["SCAN", "0", "MATCH", "acmi:t-acme:*", "MATCH", "*"]);
    await forbidden(["SCAN", "0", "MaTcH", "acmi:?cme:*"]);
    await forbidden(["SCAN", "0", "COUNT", "10", "BOGUS", "x"]);
    await forbidden(["SCAN", "0", "MATCH"]);
    await forbidden(["SCAN", "not-a-cursor"]);
  });

  test("case variants of command names are classified, not bypassed", async () => {
    await forbidden(["get", "acmi:other:secret"]);
    await forbidden(["GeT", "acmi:other:secret"]);
    await forbidden(["rEnAmE", K("mine"), "acmi:other:x"]);
    await forbidden(["keys", "*"]);
    await forbidden(["Keys", "acmi:t-acme:*"]);
    await forbidden(["eVaL", "return 1", "0"]);
    await forbidden(["flushall"]);
  });

  test("non-string keys and odd argument types are refused", async () => {
    assert.equal((await b.exec(["GET", 123])).status, 403);
    assert.equal((await b.exec(["GET", null])).status, 400);
    assert.equal((await b.exec(["GET", ["acmi:t-acme:x"]])).status, 400);
    assert.equal((await b.exec(["GET", { k: 1 }])).status, 400);
    assert.equal((await b.exec({ cmd: "GET" })).status, 400);
    assert.equal((await b.exec([])).status, 400);
    assert.equal((await b.exec(null, { raw: "{not json" })).status, 400);
  });

  test("pipeline with one bad command runs none", async () => {
    await b.redis("DEL", K("pipe1"), K("pipe2"));
    const r = await b.pipe([
      ["SET", K("pipe1"), "1"],
      ["SET", K("pipe2"), "2"],
      ["GET", "acmi:other:secret"],
    ]);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: "forbidden", index: 2 }, "names the refused command's index, nothing else");
    assert.equal(await b.redis("GET", K("pipe1")), null, "nothing ran");
    assert.equal(await b.redis("GET", K("pipe2")), null);

    const r2 = await b.pipe([["SET", K("pipe1"), "1"], ["FLUSHALL"]]);
    assert.equal(r2.status, 403);
    assert.equal(await b.redis("GET", K("pipe1")), null);
    assert.equal(await b.redis("GET", "acmi:other:secret"), "OTHER_SECRET_VALUE");
  });

  test("refusals never echo keys or values", async () => {
    for (const cmd of [
      ["GET", "acmi:other:secret"],
      ["SET", "acmi:other:secret", "SUPER_SECRET_PAYLOAD"],
      ["EVAL", "SUPER_SECRET_PAYLOAD", "0"],
      ["SUPER_SECRET_PAYLOAD", K("x")],
    ]) {
      const r = await b.exec(cmd);
      assert.ok(!r.text.includes("SUPER_SECRET_PAYLOAD"), r.text);
      assert.ok(!r.text.includes("other"), r.text);
    }
  });
});

describe("fleet and system trees", () => {
  test("a tenant named `agent` (or `cloud`, `oauth`) still cannot reach the fleet trees", async () => {
    for (const tenant of ["agent", "cloud", "oauth", "work"]) {
      const b = await startBridge({ tenant });
      try {
        await b.redis("SET", `acmi:${tenant}:fleet:profile`, "FLEET_VALUE");
        for (const key of [
          `acmi:${tenant}:fleet:profile`, "acmi:agent:opencode:profile", "acmi:work:x", "acmi:thread:x:timeline",
          "acmi:cloud:meter:agent:202610:add", "acmi:cloud:tenant:agent", "lm:oauth:code:x", "lm:onboard:probe:x",
          `lm:${tenant}:x`, "acmi:madez:bus:events",
        ]) {
          const r = await b.exec(["GET", key]);
          assert.equal(r.status, 403, `${tenant} -> ${key}`);
        }
        const scan = await b.exec(["SCAN", "0", "MATCH", `acmi:${tenant}:*`]);
        assert.equal(scan.status, 403);
        const own = await b.exec(["SCAN", "0"]);
        assert.ok(own.body.result[1].every((k) => k.startsWith(`acmi:t-${tenant}:`)));
        assert.deepEqual((await b.exec(["SET", `acmi:t-${tenant}:mine`, "1"])).body, { result: "OK" });
        assert.equal(await b.redis("GET", `acmi:${tenant}:fleet:profile`), "FLEET_VALUE");
      } finally {
        await b.close();
      }
    }
  });
});

// ---- refused commands -------------------------------------------------------------

describe("refused commands", () => {
  let b;
  before(async () => { b = await startBridge(); });
  after(async () => { await b.close(); });

  const required = [
    "EVAL", "EVALSHA", "SCRIPT", "FUNCTION", "FLUSHDB", "FLUSHALL", "CONFIG", "CLIENT", "MODULE",
    "MONITOR", "SELECT", "MIGRATE", "DEBUG", "SHUTDOWN", "REPLICAOF", "SLAVEOF", "ACL", "OBJECT",
    "SAVE", "BGSAVE", "KEYS",
  ];

  test("the required refusals are all in DENIED", () => {
    for (const c of required) assert.ok(DENIED.has(c), c);
  });

  test("every DENIED command is refused with 403, even with tenant keys as args", async () => {
    for (const c of DENIED) {
      for (const name of [c, c.toLowerCase()]) {
        const r = await b.exec([name, K("x"), K("y")]);
        assert.equal(r.status, 403, name);
        assert.deepEqual(r.body, { error: "forbidden" });
      }
    }
  });

  test("unknown commands are refused", async () => {
    for (const c of ["FOO", "GETX", "XGROUP", "GEOADD", "PFADD", "BITOP", "OBJECT ENCODING"]) {
      assert.equal((await b.exec([c, K("x")])).status, 403, c);
    }
  });
});

// ---- auth ---------------------------------------------------------------------------

describe("auth", () => {
  let b;
  before(async () => { b = await startBridge({ limits: { authFailBurst: 1000 } }); });
  after(async () => { await b.close(); });

  test("missing token: 401 generic", async () => {
    const r = await b.exec(["GET", K("a")], { token: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "unauthorized" });
  });

  test("wrong, empty, prefixed and malformed tokens: 401 generic", async () => {
    for (const token of ["nope", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), HASH]) {
      const r = await b.exec(["GET", K("a")], { token });
      assert.equal(r.status, 401, token.length);
      assert.deepEqual(r.body, { error: "unauthorized" });
    }
    for (const h of [`Basic ${TOKEN}`, TOKEN, `Bearer`, `Bearer ${TOKEN} extra`]) {
      const r = await b.exec(["GET", K("a")], { token: null, headers: { Authorization: h } });
      assert.equal(r.status, 401, h.slice(0, 6));
    }
    const ok = await b.exec(["PING"], { token: null, headers: { Authorization: `bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
  });

  test("auth is checked before the jail (no oracle for unauthenticated callers)", async () => {
    const r = await b.exec(["KEYS", "*"], { token: "wrong" });
    assert.equal(r.status, 401);
    const p = await b.pipe([["GET", "acmi:other:x"]], { token: "wrong" });
    assert.equal(p.status, 401);
  });

  test("timing-safe: fixed-length digests compared with timingSafeEqual", () => {
    assert.equal(tokenMatches(TOKEN, HASH), true);
    assert.equal(tokenMatches(TOKEN, HASH.toUpperCase().toLowerCase()), true);
    // Different lengths never reach a length-dependent comparison: both sides are sha256.
    for (const t of ["", "a", TOKEN.slice(0, 5), TOKEN + "a".repeat(10_000)]) {
      assert.equal(tokenMatches(t, HASH), false);
    }
    assert.equal(tokenMatches(undefined, HASH), false);
    assert.equal(tokenMatches(TOKEN, "zz"), false);
    const src = readFileSync(new URL("../cloud/bridge/bridge.mjs", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function tokenMatches"), src.indexOf("function bearer"));
    assert.match(fn, /timingSafeEqual\(got, want\)/);
    assert.doesNotMatch(fn, /===\s*want|want\s*===|\.equals\(/);
  });

  test("the bridge refuses to start without a valid hash or tenant", () => {
    const redis = createMemoryRedis();
    assert.throws(() => createBridge({ tenant: TENANT, tokenSha256: "", redis }));
    assert.throws(() => createBridge({ tenant: TENANT, tokenSha256: TOKEN, redis }));
    for (const tenant of ["", "A", "ab", "acme:x", "acme*", "-acme", "t-", "acme?"]) {
      assert.throws(() => createBridge({ tenant, tokenSha256: HASH, redis }), tenant);
    }
    // prefixes are config, but only this tenant's t- namespace is accepted
    for (const prefixes of [[], ["acmi:acme:"], ["acmi:t-other:"], ["acmi:t-acme:*"], ["acmi:t-acme"], ["acmi:"], "acmi:t-acme:"]) {
      assert.throws(() => createBridge({ tenant: TENANT, tokenSha256: HASH, redis, prefixes }), JSON.stringify(prefixes));
    }
    assert.ok(createBridge({ tenant: TENANT, tokenSha256: HASH, redis, prefixes: ["lm:t-acme:"] }));
  });
});

// ---- limits ---------------------------------------------------------------------------

describe("limits", () => {
  test("body > 1 MB: 413", async () => {
    const b = await startBridge();
    try {
      const big = "x".repeat(DEFAULT_LIMITS.maxBodyBytes + 10);
      const r = await b.exec(["SET", K("big"), big]);
      assert.equal(r.status, 413);
      assert.deepEqual(r.body, { error: "payload_too_large" });
      assert.equal(await b.redis("GET", K("big")), null);
    } finally {
      await b.close();
    }
  });

  test("streamed body > 1 MB without Content-Length: 413, connection closed", { timeout: 15_000 }, async () => {
    const b = await startBridge();
    try {
      const { port } = new URL(b.base);
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1", port, path: "/exec", method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        }, (res) => { res.resume(); resolve(res.statusCode); });
        // The bridge replies 413 and closes; a client still uploading may see
        // the reset (EPIPE/ECONNRESET) before it reads the reply. Either way the
        // upload is cut off and nothing lands.
        req.on("error", (e) => (e.code === "EPIPE" || e.code === "ECONNRESET" ? resolve(e.code) : reject(e)));
        req.write(`["SET","${K("chunked")}","`);
        const chunk = "x".repeat(64 * 1024);
        let sent = 0;
        const pump = () => {
          while (sent < 2 * DEFAULT_LIMITS.maxBodyBytes) {
            sent += chunk.length;
            if (!req.write(chunk)) return req.once("drain", pump);
          }
          req.end(`"]`);
        };
        pump();
      });
      assert.equal(status, 413, "the bridge drains the rest of the upload, so the client sees the status");
      assert.equal(await b.redis("GET", K("chunked")), null);
      assert.ok(b.logs.some((l) => l.op === "exec" && l.cmd === null && l.ok === false), "overflow was refused, not parsed");
      assert.equal((await b.exec(["PING"])).status, 200, "bridge still serves");
    } finally {
      await b.close();
    }
  });

  test("value > 512 KB: 413; at the limit: ok", async () => {
    const b = await startBridge();
    try {
      const r = await b.exec(["SET", K("v"), "y".repeat(DEFAULT_LIMITS.maxValueBytes + 1)]);
      assert.equal(r.status, 413);
      assert.deepEqual(r.body, { error: "value_too_large" });
      // multi-byte chars count as bytes, not code units
      const mb = await b.exec(["SET", K("v"), "é".repeat(DEFAULT_LIMITS.maxValueBytes / 2 + 1)]);
      assert.equal(mb.status, 413);
      const ok = await b.exec(["SET", K("v"), "y".repeat(DEFAULT_LIMITS.maxValueBytes)]);
      assert.equal(ok.status, 200);
      const p = await b.pipe([["SET", K("w"), "1"], ["SET", K("w2"), "z".repeat(DEFAULT_LIMITS.maxValueBytes + 1)]]);
      assert.equal(p.status, 413);
      assert.equal(await b.redis("GET", K("w")), null, "pipeline all-or-nothing on size too");
    } finally {
      await b.close();
    }
  });

  test("pipeline > 100 commands: 413; exactly 100: ok", async () => {
    const b = await startBridge();
    try {
      const mk = (n) => Array.from({ length: n }, (_, i) => ["SET", K(`n${i}`), "1"]);
      const r = await b.pipe(mk(101));
      assert.equal(r.status, 413);
      assert.deepEqual(r.body, { error: "pipeline_too_large" });
      assert.equal(await b.redis("GET", K("n0")), null);
      const ok = await b.pipe(mk(100));
      assert.equal(ok.status, 200);
      assert.equal(ok.body.length, 100);
      assert.equal((await b.pipe([])).status, 400);
      assert.equal((await b.pipe(["GET", K("x")])).status, 400, "a bare command is not a pipeline");
    } finally {
      await b.close();
    }
  });

  test("rate limit: token bucket per token, refills over time", async () => {
    let now = 1_000_000;
    const b = await startBridge({ limits: { rateCapacity: 5, rateRefillPerSec: 1, now: () => now, maxPipeline: 5, maxKeys: 5, authFailBurst: 100 } });
    try {
      for (let i = 0; i < 5; i++) assert.equal((await b.exec(["PING"])).status, 200, `call ${i}`);
      const r = await b.exec(["PING"]);
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { error: "rate_limited" });
      now += 2000; // 2 tokens back
      assert.equal((await b.exec(["PING"])).status, 200);
      // a pipeline costs one token per command
      const p = await b.pipe([["PING"], ["PING"], ["PING"]]);
      assert.equal(p.status, 429);
      now += 10_000;
      assert.equal((await b.pipe([["PING"], ["PING"], ["PING"]])).status, 200);
      // unauthenticated calls do not drain the bucket
      for (let i = 0; i < 20; i++) await b.exec(["PING"], { token: "wrong" });
      assert.equal((await b.exec(["PING"])).status, 200);
    } finally {
      await b.close();
    }
  });
});

// ---- metering and quota ------------------------------------------------------------

function fakeMeter({ addLimit = Infinity } = {}) {
  const calls = { meter: [], check: [] };
  const used = { add: 0, read: 0 };
  return {
    calls,
    used,
    async meter(redis, tenant, op, n) {
      assert.equal(typeof redis, "function");
      calls.meter.push({ tenant, op, n });
      used[op] += n;
    },
    async refund(redis, tenant, op, n) {
      calls.refund = [...(calls.refund ?? []), { tenant, op, n }];
      used[op] -= n;
    },
    async checkQuota(redis, tenant, op, plan, { n }) {
      calls.check.push({ tenant, op, plan, n });
      const limit = op === "add" ? addLimit : Infinity;
      return used[op] + n <= limit
        ? { ok: true, used: used[op], limit }
        : { ok: false, code: "quota_exceeded", used: used[op], limit, grace: 0 };
    },
  };
}

describe("metering", () => {
  test("adds are quota-checked then metered; reads are metered, never refused", async () => {
    const meter = fakeMeter({ addLimit: 2 });
    const b = await startBridge({ meter, plan: { name: "starter" } });
    try {
      assert.equal((await b.exec(["SET", K("q1"), "1"])).status, 200);
      assert.equal((await b.exec(["SET", K("q2"), "2"])).status, 200);
      const r = await b.exec(["SET", K("q3"), "3"]);
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { error: "quota_exceeded" });
      assert.equal(await b.redis("GET", K("q3")), null, "refused write did not land");

      // reads still work over quota
      for (let i = 0; i < 5; i++) assert.deepEqual((await b.exec(["GET", K("q1")])).body, { result: "1" });
      assert.equal((await b.exec(["SCAN", "0"])).status, 200);
      assert.equal(meter.used.read, 6);
      assert.equal(meter.used.add, 2);
      assert.ok(meter.calls.check.every((c) => c.op === "add" && c.tenant === TENANT && c.plan.name === "starter"));
      assert.ok(!meter.calls.check.some((c) => c.op === "read"), "reads never call checkQuota");
    } finally {
      await b.close();
    }
  });

  test("pipeline: quota checked once for all adds; over quota runs none", async () => {
    const meter = fakeMeter({ addLimit: 3 });
    const b = await startBridge({ meter, plan: { name: "fake" } });
    try {
      const ok = await b.pipe([["SET", K("a"), "1"], ["GET", K("a")], ["SET", K("b"), "2"]]);
      assert.equal(ok.status, 200);
      assert.deepEqual(meter.calls.check.at(-1).n, 2);
      assert.equal(meter.used.add, 2);
      assert.equal(meter.used.read, 1);
      const over = await b.pipe([["SET", K("c"), "1"], ["SET", K("d"), "2"]]);
      assert.equal(over.status, 429);
      assert.equal(await b.redis("GET", K("c")), null);
      const reads = await b.pipe([["GET", K("a")], ["GET", K("b")]]);
      assert.equal(reads.status, 200, "read-only pipeline over quota still runs");
    } finally {
      await b.close();
    }
  });

  test("failed commands are not metered; quota errors fail closed for writes only", async () => {
    const meter = fakeMeter();
    const b = await startBridge({ meter });
    try {
      await b.exec(["SADD", K("set"), "x"]);
      const before = meter.used.add;
      const r = await b.exec(["INCR", K("set")]); // WRONGTYPE
      assert.equal(r.status, 400);
      assert.equal(meter.used.add, before);
    } finally {
      await b.close();
    }
    const broken = { meter: async () => {}, checkQuota: async () => { throw new Error("redis down"); } };
    const b2 = await startBridge({ meter: broken, plan: { name: "fake" } });
    try {
      assert.equal((await b2.exec(["SET", K("x"), "1"])).status, 503);
      assert.equal((await b2.exec(["GET", K("x")])).status, 200);
    } finally {
      await b2.close();
    }
  });

  test("billed overage {ok:true, overage:true} is not refused; only {ok:false, code:quota_exceeded} is a 429", async () => {
    const answers = [
      { ok: true, used: 10, limit: 10, grace: false, overage: true },
      { ok: true, used: 10, limit: 10, grace: true },
      { ok: false, code: "quota_exceeded", used: 11, limit: 10 },
      { ok: false, code: "something_else" },
      { ok: false },
      null,
    ];
    let i = 0;
    const counted = [];
    const meter = {
      meter: async (_r, _t, op, n) => counted.push([op, n]),
      checkQuota: async () => answers[i++],
    };
    const plan = { limits: { add: 10, read: null }, overage: { billed: true } };
    const b = await startBridge({ meter, plan });
    try {
      const st = [];
      for (let j = 0; j < answers.length; j++) st.push((await b.exec(["SET", K(`o${j}`), "1"])).status);
      assert.deepEqual(st, [200, 200, 429, 503, 503, 503]);
      assert.equal(await b.redis("GET", K("o0")), "1", "overage write landed");
      assert.equal(await b.redis("GET", K("o2")), null);
      assert.deepEqual(counted, [["add", 1], ["add", 1]], "billed plan: checkQuota does not count, meter() does");
    } finally {
      await b.close();
    }
  });

  test("checkQuota {reserved:true}: the add is already counted, meter() does not count it again", async () => {
    const counted = [];
    let checks = 0;
    const meter = {
      meter: async (_r, _t, op, n) => counted.push([op, n]),
      checkQuota: async (_r, _t, _op, _p, { n }) => { checks += n; return { ok: true, used: 0, limit: 10, grace: false, reserved: true }; },
    };
    const plan = { limits: { add: 10, read: null }, overage: null };
    const b = await startBridge({ meter, plan });
    try {
      assert.equal((await b.exec(["SET", K("r1"), "1"])).status, 200);
      assert.equal((await b.pipe([["SET", K("r2"), "1"], ["GET", K("r1")]])).status, 200);
      await b.exec(["GET", K("r1")]);
      assert.equal(checks, 2);
      assert.deepEqual(counted, [["read", 1], ["read", 1]], "adds counted once (by the reserve), reads by meter()");
    } finally {
      await b.close();
    }
    // {reserved:false} (or absent): meter() counts the add, before it runs.
    const counted2 = [];
    const m2 = { meter: async (_r, _t, op, n) => counted2.push([op, n]), checkQuota: async () => ({ ok: true, reserved: false }) };
    const b2 = await startBridge({ meter: m2, plan });
    try {
      await b2.exec(["SET", K("r3"), "1"]);
      assert.deepEqual(counted2, [["add", 1]]);
    } finally {
      await b2.close();
    }
  });

  test("meter without a plan: counts, never checks", async () => {
    const meter = fakeMeter({ addLimit: 0 });
    const b = await startBridge({ meter, plan: null });
    try {
      assert.equal((await b.exec(["SET", K("np"), "1"])).status, 200);
      assert.equal(meter.calls.check.length, 0);
      assert.deepEqual(meter.calls.meter.map((c) => c.op), ["add"]);
    } finally {
      await b.close();
    }
  });

  test("no meter: nothing is enforced or counted", async () => {
    const b = await startBridge({ meter: null });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await b.exec(["SET", K(`n${i}`), "1"])).status, 200);
    } finally {
      await b.close();
    }
  });
});

// ---- redis-rest.mjs end to end -----------------------------------------------------

describe("redis-rest.mjs through the bridge", () => {
  test("createRedis works unchanged against /exec and /", async () => {
    const b = await startBridge();
    try {
      for (const url of [`${b.base}/exec`, `${b.base}/`, b.base]) {
        const r = createRedis({ url, token: TOKEN });
        assert.equal(await r("SET", K("rest"), "hello"), "OK");
        assert.equal(await r("GET", K("rest")), "hello");
        assert.equal(await r("ZADD", K("z"), 1, "m1"), 1);
        assert.equal(await r("ZADD", K("z"), 2, "m2"), 1);
        assert.deepEqual(await r("ZRANGE", K("z"), 0, -1, "WITHSCORES"), ["m1", "1", "m2", "2"]);
        assert.equal(await r("HSET", K("h"), "f", "1"), 1);
        assert.deepEqual(await r("HGETALL", K("h")), ["f", "1"]);
        assert.equal(await r("DEL", K("rest"), K("z"), K("h")), 3);
        await assert.rejects(() => r("GET", "acmi:other:x"), /HTTP 403/);
        const bad = createRedis({ url, token: "wrong" });
        await assert.rejects(() => bad("GET", K("rest")), /HTTP 401/);
      }
    } finally {
      await b.close();
    }
  });

  test("scripts/bridge-probe.mjs passes through a bridge for tenant `probe`-style keys", async () => {
    // The probe writes lm:probe:<ts>:*; give it a runner that maps that space
    // onto this tenant so it exercises every command the repo uses.
    const b = await startBridge();
    try {
      const r = createRedis({ url: `${b.base}/exec`, token: TOKEN });
      const mapped = (...cmd) => r(...cmd.map((a) => (typeof a === "string" ? a.replace(/^lm:probe:/, `lm:t-${TENANT}:probe:`) : a)));
      const out = await probe(mapped);
      assert.equal(out.ok, true, JSON.stringify(out.results.filter((x) => !x.ok)));
    } finally {
      await b.close();
    }
  });
});

// ---- logs ------------------------------------------------------------------------------

describe("logs", () => {
  test("JSON lines carry tenant, op, cmd, ok and ms only: never keys, values or tokens", async () => {
    const meter = fakeMeter({ addLimit: 1 });
    const b = await startBridge({ meter, plan: { name: "fake" } });
    try {
      const SECRET = "LOG_SECRET_VALUE_9f8e7d";
      await b.exec(["SET", K(`key-${SECRET}`), SECRET]);
      await b.exec(["SET", K("k2"), SECRET]); // quota refusal
      await b.exec(["GET", K(`key-${SECRET}`)]);
      await b.exec(["GET", `acmi:other:${SECRET}`]);
      await b.exec([SECRET, K("x")]);
      await b.exec(["SADD", K(`key-${SECRET}`), SECRET]); // WRONGTYPE
      await b.pipe([["GET", K(SECRET)], ["EVAL", SECRET, "0"]]);
      await b.pipe([["GET", K(SECRET)], ["HGET", K(SECRET), SECRET]]);
      await b.exec(["GET", K("x")], { token: `${SECRET}-token` });
      await b.exec(["SET", K("x"), "z".repeat(DEFAULT_LIMITS.maxValueBytes + 1)]);

      assert.ok(b.logs.length >= 8);
      const all = JSON.stringify(b.logs);
      assert.ok(!all.includes(SECRET), all);
      assert.ok(!all.includes(TOKEN));
      assert.ok(!all.includes(HASH));
      assert.ok(!all.includes("acmi:"), "no keys at all");
      for (const l of b.logs) {
        assert.deepEqual(Object.keys(l).sort(), ["cmd", "ms", "ok", "op", "tenant"]);
        assert.equal(l.tenant, TENANT);
        assert.equal(typeof l.ok, "boolean");
        assert.equal(typeof l.ms, "number");
        assert.ok(l.cmd === null || l.cmd === "?" || /^[A-Z_]+$/.test(l.cmd), l.cmd);
      }
      assert.ok(b.logs.some((l) => l.op === "add" && l.cmd === "SET" && l.ok));
      assert.ok(b.logs.some((l) => l.op === "auth" && !l.ok));
      assert.ok(b.logs.some((l) => l.cmd === "?"), "unknown command names are masked");
    } finally {
      await b.close();
    }
  });

  test("Redis error text is reduced to its class", () => {
    assert.equal(genericRedisError(new Error("WRONGTYPE Operation against a key holding the wrong kind of value")), "WRONGTYPE command failed");
    assert.equal(genericRedisError(new Error("ERR unknown command 'x', with args beginning with: 'acmi:t-acme:secret'")), "ERR command failed");
    assert.equal(genericRedisError(new Error("native redis connect failed: getaddrinfo redis.internal")), "ERR command failed");
    assert.equal(genericRedisError(undefined), "ERR command failed");
  });

  test("a Redis error never reaches the caller verbatim", async () => {
    const redis = async () => { throw new Error("ERR value acmi:t-acme:leak is SECRET_IN_ERROR"); };
    const b = await startBridge({ redis });
    try {
      const r = await b.exec(["GET", K("leak")]);
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: "ERR command failed" });
    } finally {
      await b.close();
    }
  });
});

// ---- fakes for a redis:// upstream ------------------------------------------------------

/** memory-redis plus MSET/MGET (it implements only what the server uses). */
function withMulti(mem = createMemoryRedis()) {
  const r = async (cmd, ...a) => {
    const n = String(cmd).toUpperCase();
    if (n === "MSET") {
      for (let i = 0; i < a.length; i += 2) await mem("SET", a[i], a[i + 1]);
      return "OK";
    }
    if (n === "MGET") return Promise.all(a.map((k) => mem("GET", k)));
    return mem(cmd, ...a);
  };
  r._data = mem._data;
  return r;
}

/** One valid, jailed sample of every command in COMMANDS. */
function sampleCommand(name) {
  const spec = COMMANDS[name].spec;
  switch (spec) {
    case "none": return [name];
    case "scan": return ["SCAN", "0", "COUNT", "10"];
    case "kscan": return [name, K("k"), "0", "COUNT", "10"];
    case "one": return [name, K("k"), "a", "1"];
    case "two": return name === "COPY" ? [name, K("a"), K("b")] : [name, K("a"), K("b"), "LEFT", "RIGHT"];
    case "copy": return [name, K("a"), K("b")];
    case "all": return [name, K("a"), K("b")];
    case "pairs": return [name, K("a"), "1", K("b"), "2"];
    case "destnum": return [name, K("d"), "2", K("a"), K("b")];
    case "num": return [name, "2", K("a"), K("b")];
    default: throw new Error(spec);
  }
}

const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");

function respEncode(v) {
  if (v === null || v === undefined) return "$-1\r\n";
  if (v instanceof Error) return `-${String(v.message).replace(/[\r\n]/g, " ")}\r\n`;
  if (typeof v === "number") return `:${v}\r\n`;
  if (Array.isArray(v)) return `*${v.length}\r\n${v.map(respEncode).join("")}`;
  const str = String(v);
  return `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
}

/**
 * A fake Redis speaking RESP2 on a real TCP port.
 *   handle(cmd) -> reply   default: memory-redis, plus AUTH, SELECT, EVALSHA/SCRIPT LOAD
 *   users       { name: password } for AUTH user pass
 *   deny(cmd)   true -> NOPERM (a stand-in for a Redis ACL)
 */
async function startFakeRedis({ mem = withMulti(), users = null, deny = () => false, acl = null, handle = null } = {}) {
  const scripts = new Map();
  const seen = [];
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    const parser = createParser();
    let authed = !users;
    let user = "default";
    let chain = Promise.resolve();
    sock.on("data", (chunk) => {
      let cmds;
      try { cmds = parser.feed(chunk); } catch { return sock.destroy(); }
      for (const cmd of cmds) {
        chain = chain.then(async () => {
          seen.push(cmd);
          const name = String(cmd[0]).toUpperCase();
          let reply;
          try {
            if (handle) reply = await handle(cmd);
            else if (name === "AUTH") {
              const [u, pw] = cmd.length === 3 ? [cmd[1], cmd[2]] : ["default", cmd[1]];
              if (users?.[u] !== pw) throw new Error("WRONGPASS invalid username-password pair or user is disabled.");
              authed = true;
              user = u;
              reply = "OK";
            } else if (!authed) throw new Error("NOAUTH Authentication required.");
            else if (deny(cmd, user) || (acl && !acl(user, cmd))) throw new Error(`NOPERM User has no permissions to run the '${cmd[0]}' command`);
            else if (name === "SELECT") reply = "OK";
            else if (name === "SCRIPT" && String(cmd[1]).toUpperCase() === "LOAD") {
              scripts.set(sha1(cmd[2]), cmd[2]);
              reply = sha1(cmd[2]);
            } else if (name === "EVALSHA") {
              const src = scripts.get(cmd[1]);
              if (!src) throw new Error("NOSCRIPT No matching script. Please use EVAL.");
              reply = await mem("EVAL", src, ...cmd.slice(2));
            } else {
              if (name === "EVAL") scripts.set(sha1(cmd[1]), cmd[1]);
              reply = await mem(...cmd);
            }
          } catch (e) {
            reply = e instanceof Error ? e : new Error(String(e));
          }
          if (!sock.destroyed) sock.write(respEncode(reply));
        });
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    mem, seen, scripts,
    url: (auth = "") => `redis://${auth}127.0.0.1:${server.address().port}`,
    close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); },
  };
}

/**
 * Parse cloud/bridge/acl.template.txt into an ACL check for the fake Redis:
 * acl(user, cmd) -> allowed. Supports exactly what the template uses:
 * reset, on, #hash, resetkeys, ~pattern, resetchannels, -@all, +command.
 */
function aclFromTemplate(tenant) {
  const text = readFileSync(new URL("../cloud/bridge/acl.template.txt", import.meta.url), "utf8").replaceAll("{{TENANT}}", tenant);
  const users = {};
  for (const line of text.split("\n").filter((l) => l.startsWith("user "))) {
    const [, name, ...rules] = line.split(" ");
    const u = { keys: [], cmds: new Set() };
    for (const r of rules) {
      if (r.startsWith("~")) u.keys.push(new RegExp(`^${r.slice(1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
      else if (r.startsWith("+")) u.cmds.add(r.slice(1).toUpperCase());
    }
    users[name] = u;
  }
  return (user, cmd) => {
    const u = users[user];
    if (!u) return true; // the default user of a dev Redis
    const name = String(cmd[0]).toUpperCase();
    if (!u.cmds.has(name)) return false;
    let keys;
    if (name === "EVALSHA") keys = cmd.slice(3, 3 + Number(cmd[2]));
    else if (name === "PING" || name === "SCAN") keys = [];
    else if (Object.hasOwn(COMMANDS, name)) keys = keyArgs(cmd);
    else keys = [cmd[1]];
    return keys.every((k) => u.keys.some((re) => re.test(String(k))));
  };
}

// ---- resp.mjs: the zero-dependency native runner ---------------------------------------

describe("resp.mjs", () => {
  test("encode / parse round trip, including nested arrays, nil, integers and errors", () => {
    assert.equal(encodeCommand(["SET", "k", "é"]).toString(), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n");
    const p = createParser();
    const wire = "+OK\r\n:42\r\n$-1\r\n*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n-WRONGTYPE bad\r\n*-1\r\n";
    // fed one byte at a time: replies only complete when their bytes arrive
    const out = [];
    for (const ch of Buffer.from(wire)) out.push(...p.feed(Buffer.from([ch])));
    assert.deepEqual(out.slice(0, 4), ["OK", 42, null, ["0", ["a", "b"]]]);
    assert.match(out[4].message, /^WRONGTYPE/);
    assert.equal(out[5], null);
  });

  test("AUTH with a per-tenant ACL user, SELECT, replies in Upstash shape", async () => {
    const fake = await startFakeRedis({ users: { "acmi-t-acme": "pw-acme" } });
    const r = createRespRunner(`${fake.url("acmi-t-acme:pw-acme@")}/2`);
    try {
      assert.equal(await r("SET", K("a"), "1"), "OK");
      assert.equal(await r("INCRBY", K("a"), 4), 5);
      assert.equal(await r("GET", K("a")), "5");
      await r("HSET", K("h"), "f", "v");
      assert.deepEqual(await r("HGETALL", K("h")), ["f", "v"]);
      assert.equal(await r("GET", K("none")), null);
      await assert.rejects(() => r("SADD", K("a"), "x"), /^RespError: WRONGTYPE/);
      assert.deepEqual(fake.seen.slice(0, 2), [["AUTH", "acmi-t-acme", "pw-acme"], ["SELECT", "2"]]);
    } finally {
      await r.close();
      await fake.close();
    }
  });

  test("wrong password and unreachable hosts fail with generic errors (no URL, user or password)", async () => {
    const fake = await startFakeRedis({ users: { "acmi-t-acme": "right" } });
    const bad = createRespRunner(fake.url("acmi-t-acme:WRONG_PW_SECRET@"));
    try {
      const e = await bad("PING").catch((x) => x);
      assert.equal(e.message, "redis auth failed");
    } finally {
      await bad.close();
      await fake.close();
    }
    const dead = createRespRunner(`redis://u:SECRETPW@127.0.0.1:1`, { connectTimeoutMs: 500 });
    const e2 = await dead("PING").catch((x) => x);
    assert.match(e2.message, /^redis (connection failed|connection closed|connect timed out)$/);
    assert.ok(!/SECRETPW|127\.0\.0\.1|:1\b/.test(e2.message));
  });

  test("a command timeout drops the connection, fails in-flight work, and the next call reconnects", async () => {
    let hang = true;
    const mem = createMemoryRedis();
    const fake = await startFakeRedis({ handle: async (cmd) => (hang && cmd[0] === "GET" ? new Promise(() => {}) : mem(...cmd)) });
    const r = createRespRunner(fake.url(), { timeoutMs: 150 });
    try {
      const t0 = Date.now();
      await assert.rejects(() => r("GET", K("x")), /timed out/);
      assert.ok(Date.now() - t0 < 2000);
      hang = false;
      assert.equal(await r("PING"), "PONG");
    } finally {
      await r.close();
      await fake.close();
    }
  });

  test("the full COMMANDS table runs verbatim on a redis:// upstream (fake RESP server)", async () => {
    const fake = await startFakeRedis({ handle: async (cmd) => ["echo", ...cmd] });
    const r = createRespRunner(fake.url());
    try {
      for (const name of Object.keys(COMMANDS)) {
        const c = checkCommand(sampleCommand(name), { prefixes: tenantPrefixes(TENANT) });
        assert.equal(c.ok, true, name);
        const reply = await r(...c.cmd);
        assert.deepEqual(reply, ["echo", ...c.cmd.map(String)], name);
      }
      assert.equal(fake.seen.length, Object.keys(COMMANDS).length);
    } finally {
      await r.close();
      await fake.close();
    }
  });
});

// ---- src/lib/redis-native.mjs covers the bridge table too ---------------------------

describe("redis-native.mjs translate() and the bridge table", () => {
  const fakeClient = () => {
    const calls = [];
    const client = new Proxy({}, {
      get: (_t, prop) => (...args) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve(prop === "hGetAll" ? {} : /Range/.test(String(prop)) ? [] : "OK");
      },
    });
    return { client, calls };
  };
  const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : v && typeof v === "object" ? [...Object.keys(v), ...Object.values(v)].flatMap(flat) : [String(v)]);

  test("every COMMANDS entry is translated, and every key argument reaches the client", async () => {
    for (const name of Object.keys(COMMANDS)) {
      const cmd = sampleCommand(name);
      const { client, calls } = fakeClient();
      await translate(client, cmd[0], cmd.slice(1));
      assert.equal(calls.length, 1, name);
      const sent = flat(calls[0].args);
      for (const k of keyArgs(cmd)) assert.ok(sent.includes(k), `${name}: key ${k} dropped`);
    }
  });

  test("options are not dropped: EXISTS multi-key, ZRANGE BYSCORE/LIMIT, SCAN TYPE", async () => {
    const run = async (cmd) => {
      const { client, calls } = fakeClient();
      await translate(client, cmd[0], cmd.slice(1));
      return calls[0];
    };
    assert.deepEqual(flat((await run(["EXISTS", K("a"), K("b")])).args), [K("a"), K("b")]);
    assert.deepEqual((await run(["ZRANGE", K("z"), "0", "10", "BYSCORE", "LIMIT", "0", "5"])).args[0],
      ["ZRANGE", K("z"), "0", "10", "BYSCORE", "LIMIT", "0", "5"]);
    assert.ok((await run(["SCAN", "0", "MATCH", `${K("")}*`, "COUNT", "10", "TYPE", "hash"])).args[0].includes("TYPE"));
  });

  test("HSET keeps a field named __proto__ (null-prototype pairs)", async () => {
    const { client, calls } = fakeClient();
    await translate(client, "HSET", [K("h"), "__proto__", "x", "b", "y"]);
    const fields = calls[0].args[1];
    assert.equal(Object.getPrototypeOf(fields), null);
    assert.deepEqual(Object.keys(fields).sort(), ["__proto__", "b"]);
    assert.equal(fields.__proto__, "x");
  });
});

// ---- review fixes (PR #30) ------------------------------------------------------------

describe("H1: metering fails closed", () => {
  test("a meter() error refuses the WRITE with 503 and runs nothing; reads still run", async () => {
    const meter = {
      meter: async (_r, _t, op) => { if (op === "add") throw new Error("native redis: unsupported command INCRBY"); throw new Error("read count down too"); },
      checkQuota: async () => ({ ok: true, reserved: false, overage: true }),
    };
    const b = await startBridge({ meter, plan: { limits: { add: 10, read: null }, overage: { billed: true } } });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await b.exec(["SET", K(`h1-${i}`), "1"]);
        assert.equal(r.status, 503);
        assert.deepEqual(r.body, { error: "unavailable" });
      }
      assert.equal(await b.redis("GET", K("h1-0")), null, "no uncounted write landed");
      await b.redis("SET", K("r"), "v");
      assert.deepEqual((await b.exec(["GET", K("r")])).body, { result: "v" }, "reads allowed even when counting fails");
      assert.equal((await b.pipe([["GET", K("r")], ["SET", K("x"), "1"]])).status, 503);
      assert.equal(await b.redis("GET", K("x")), null);
      assert.ok(b.logs.some((l) => l.op === "meter" && l.ok === false));
    } finally {
      await b.close();
    }
  });

  test("no plan, meter only: a counting error still refuses the write", async () => {
    const meter = { meter: async () => { throw new Error("down"); }, checkQuota: async () => ({ ok: true }) };
    const b = await startBridge({ meter, plan: null });
    try {
      assert.equal((await b.exec(["SET", K("np"), "1"])).status, 503);
      assert.equal((await b.exec(["PING"])).status, 200);
    } finally {
      await b.close();
    }
  });

  test("slice A meter on a native runner that lacks INCRBY/EVAL: every write 503, nothing unmetered", async () => {
    const NATIVE_OLD = new Set(["PING", "GET", "SET", "DEL", "EXISTS", "TYPE", "SCAN", "TTL", "EXPIRE", "HGET", "HSET", "HDEL", "HGETALL", "SADD", "SREM", "SMEMBERS", "LPUSH", "RPUSH", "LRANGE", "ZADD", "ZREM", "ZCARD", "ZSCORE", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "INCR", "DECR"]);
    const plans = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
    for (const id of ["pro", "dev", "free"]) {
      const inner = createMemoryRedis();
      const redis = async (...c) => {
        if (!NATIVE_OLD.has(String(c[0]).toUpperCase())) throw new Error(`native redis: unsupported command ${c[0]}`);
        return inner(...c);
      };
      const plan = { grace_ratio: plans.grace_ratio, ...plans.plans[id], id };
      const b = await startBridge({ redis, meter: { meter: sliceA.meter, checkQuota: sliceA.checkQuota }, plan });
      try {
        for (let i = 0; i < 3; i++) assert.equal((await b.exec(["SET", K(`a${i}`), "1"])).status, 503, id);
        assert.equal(await inner("GET", K("a0")), null, `${id}: no write landed`);
        assert.equal((await sliceA.usage(inner, TENANT)).add, 0);
      } finally {
        await b.close();
      }
      // and the startup self-test would have refused to start on this upstream
      await assert.rejects(() => selfTest({ redis, meter: { ...sliceA, reserveScript: sliceA.RESERVE_LUA, ttlSeconds: 60 }, plan, tenant: TENANT }), /self-test failed/);
    }
  });

  test("slice A meter, exactly once: dev (reserved) and pro (counted by meter())", async () => {
    const plans = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
    for (const id of ["dev", "pro"]) {
      const redis = withMulti();
      const plan = { grace_ratio: plans.grace_ratio, ...plans.plans[id], id };
      const b = await startBridge({ redis, meter: { meter: sliceA.meter, checkQuota: sliceA.checkQuota }, plan });
      try {
        await b.exec(["SET", K("a"), "1"]);
        await b.exec(["INCR", K("n")]);
        await b.pipe([["SET", K("b"), "1"], ["GET", K("b")], ["SET", K("c"), "1"]]);
        await b.exec(["GET", K("a")]);
        await b.exec(["MSET", K("m1"), "1", K("m2"), "2", K("m3"), "3"]);
        const u = await sliceA.usage(redis, TENANT);
        assert.equal(u.add, 7, `${id} add (MSET of 3 = 3 adds)`);
        assert.equal(u.read, 2, `${id} read`);
        assert.equal(u.ops_total, 9);
      } finally {
        await b.close();
      }
    }
  });

  test("startup self-test passes on a healthy upstream and checks the meter's own keys", async () => {
    const plans = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
    const redis = createMemoryRedis();
    const meter = { ...sliceA, reserveScript: sliceA.RESERVE_LUA, ttlSeconds: sliceA.METER_TTL_SECONDS };
    const plan = { grace_ratio: plans.grace_ratio, ...plans.plans.dev, id: "dev" };
    assert.deepEqual(await selfTest({ redis, meter, plan, tenant: TENANT }), { metered: true });
    assert.deepEqual(await selfTest({ redis, meter: null, plan: null, tenant: TENANT }), { metered: false });
    const u = await sliceA.usage(redis, TENANT);
    assert.equal(u.add, 0, "the reserve probe is a no-op");
    assert.equal(u.ops_total, 0);
    assert.equal(await redis("GET", `${tenantPrefixes(TENANT)[0]}bridge:selftest`), null, "scratch key removed");
    // a broken plan or a meter that cannot count also refuses to start
    await assert.rejects(() => selfTest({ redis, meter, plan: { limits: {} }, tenant: TENANT }), /self-test failed: quota check/);
    const noIncr = async (...c) => (c[0] === "INCRBY" && c[1].startsWith("acmi:cloud:") ? Promise.reject(new Error("NOPERM")) : redis(...c));
    await assert.rejects(() => selfTest({ redis: noIncr, meter, plan, tenant: TENANT }), /self-test failed: meter counter/);
  });

  test("meterRunner sends EVAL as EVALSHA first and falls back on NOSCRIPT only", async () => {
    const fake = await startFakeRedis();
    const r = meterRunner(createRespRunner(fake.url()));
    try {
      const k = `acmi:cloud:meter:${TENANT}:${utcMonth(Date.now())}`;
      const res = await r("EVAL", sliceA.RESERVE_LUA, 2, `${k}:add`, `${k}:ops_total`, "1", "10", "11", "60");
      assert.equal(Number(res[0]), 1);
      const names = fake.seen.map((c) => c[0]);
      assert.deepEqual(names.slice(0, 2), ["EVALSHA", "EVAL"], "NOSCRIPT, then EVAL");
      await r("EVAL", sliceA.RESERVE_LUA, 2, `${k}:add`, `${k}:ops_total`, "1", "10", "11", "60");
      assert.equal(fake.seen.at(-1)[0], "EVALSHA", "cached script: EVALSHA only");
    } finally {
      await r.close();
      await fake.close();
    }
    // a non-NOSCRIPT error (e.g. NOPERM) is not retried as EVAL
    let evals = 0;
    const deny = meterRunner(async (...c) => { if (c[0] === "EVAL") evals++; throw new Error("NOPERM no"); });
    await assert.rejects(() => deny("EVAL", "return 1", 0), /NOPERM/);
    assert.equal(evals, 0);
  });
});

describe("M1: SCAN / HSCAN / SSCAN / ZSCAN COUNT capped", () => {
  const P = { prefixes: tenantPrefixes(TENANT) };
  test("COUNT over 1000 refused, 1000 accepted, options checked", () => {
    assert.equal(checkCommand(["SCAN", "0", "COUNT", "1000"], P).ok, true);
    assert.equal(checkCommand(["SCAN", "0", "COUNT", "1001"], P).ok, false);
    assert.equal(checkCommand(["SCAN", "0", "COUNT", "999999"], P).ok, false);
    assert.equal(checkCommand(["SCAN", "0", "COUNT", "0"], P).ok, false);
    for (const n of ["HSCAN", "SSCAN", "ZSCAN"]) {
      assert.equal(checkCommand([n, K("k"), "0", "COUNT", "1000", "MATCH", "f*"], P).ok, true, n);
      assert.equal(checkCommand([n, K("k"), "0", "COUNT", "1001"], P).ok, false, n);
      assert.equal(checkCommand([n, K("k"), "0", "BOGUS", "1"], P).ok, false, n);
      assert.equal(checkCommand([n, K("k"), "x"], P).ok, false, n);
      assert.equal(checkCommand([n, "acmi:t-other:k", "0"], P).ok, false, n);
    }
    assert.equal(checkCommand(["HSCAN", K("k"), "0", "NOVALUES"], P).ok, true);
    assert.equal(checkCommand(["SSCAN", K("k"), "0", "NOVALUES"], P).ok, false);
  });

  test("SCAN costs ceil(COUNT/100) rate tokens", () => {
    assert.equal(checkCommand(["SCAN", "0"], P).weight, 1);
    assert.equal(checkCommand(["SCAN", "0", "COUNT", "1000"], P).weight, 10);
    assert.equal(checkCommand(["ZSCAN", K("z"), "0", "COUNT", "250"], P).weight, 3);
  });
});

describe("M2: arguments per command capped; multi-key writes metered per key", () => {
  const P = { prefixes: tenantPrefixes(TENANT) };
  const pairs = (n) => Array.from({ length: n }, (_, i) => [K(`k${i}`), "v"]).flat();
  test("<= 1000 keys and <= 2001 arguments per command, <= 1 MB per command", () => {
    assert.equal(checkCommand(["MSET", ...pairs(1000)], P).ok, true);
    assert.deepEqual(checkCommand(["MSET", ...pairs(1001)], P), { ok: false, status: 413, error: "too_many_arguments" });
    assert.deepEqual(checkCommand(["MSET", ...pairs(1000)], { ...P, maxArgs: 5000 }), { ok: true, op: "add", name: "MSET", cmd: ["MSET", ...pairs(1000)], weight: 1000 });
    assert.equal(checkCommand(["MSET", ...pairs(1001)], { ...P, maxArgs: 5000 }).error, "too_many_keys");
    const keys = (n) => Array.from({ length: n }, (_, i) => K(`k${i}`));
    for (const c of ["DEL", "UNLINK", "EXISTS", "MGET", "TOUCH", "SINTER"]) {
      assert.equal(checkCommand([c, ...keys(1000)], P).ok, true, c);
      assert.equal(checkCommand([c, ...keys(1001)], P).error, "too_many_keys", c);
    }
    const members = (n) => Array.from({ length: n }, (_, i) => `m${i}`);
    assert.equal(checkCommand(["SADD", K("s"), ...members(2000)], P).ok, true);
    assert.equal(checkCommand(["SADD", K("s"), ...members(2001)], P).error, "too_many_arguments");
    assert.equal(checkCommand(["ZADD", K("z"), ...members(2002)], P).error, "too_many_arguments");
    assert.equal(checkCommand(["HSET", K("h"), ...members(2002)], P).error, "too_many_arguments");
    const big = "x".repeat(400 * 1024);
    assert.equal(checkCommand(["MSET", K("a"), big, K("b"), big, K("c"), big], P).error, "command_too_large");
    assert.equal(checkCommand(["MSET", K("a"), big, K("b"), big], P).ok, true);
  });

  test("MSET with N pairs = N adds to the quota and N rate tokens", async () => {
    const seen = [];
    const meter = {
      checkQuota: async (_r, _t, _op, _p, { n }) => (seen.push(n), { ok: true, reserved: true }),
      meter: async () => {},
    };
    let now = 0;
    const b = await startBridge({ redis: withMulti(), meter, plan: { limits: { add: 10 } }, limits: { rateCapacity: 1000, rateRefillPerSec: 1, maxKeys: 1000, now: () => now } });
    try {
      assert.equal((await b.exec(["MSET", ...pairs(500)])).status, 200);
      assert.deepEqual(seen, [500]);
      assert.equal((await b.exec(["MSET", ...pairs(400)])).status, 200);
      const r = await b.exec(["MGET", ...pairs(101).filter((_, i) => i % 2 === 0)]);
      assert.equal(r.status, 429, "500 + 400 + 101 keys > 1000 tokens");
      assert.deepEqual(r.body, { error: "rate_limited" });
    } finally {
      await b.close();
    }
  });
});

describe("L1: a pipeline whose writes are refused runs nothing, and says why", () => {
  test("over quota: 429 quota_exceeded with the first write's index; reads did not run", async () => {
    const calls = [];
    const redis = async (...c) => (calls.push(c), "OK");
    const meter = { meter: async () => {}, checkQuota: async () => ({ ok: false, code: "quota_exceeded", used: 10, limit: 10 }) };
    const b = await startBridge({ redis, meter, plan: { limits: { add: 10 } } });
    try {
      const r = await b.pipe([["GET", K("a")], ["SET", K("b"), "1"], ["GET", K("c")]]);
      assert.equal(r.status, 429);
      assert.deepEqual(r.body, { error: "quota_exceeded", index: 1 });
      assert.equal(calls.length, 0);
      assert.equal((await b.pipe([["GET", K("a")], ["GET", K("c")]])).status, 200, "a read-only pipeline still runs");
      const m2 = { meter: async () => {}, checkQuota: async () => { throw new Error("down"); } };
      const b2 = await startBridge({ redis, meter: m2, plan: { limits: { add: 1 } } });
      try {
        assert.deepEqual((await b2.pipe([["GET", K("a")], ["SET", K("b"), "1"]])).body, { error: "unavailable", index: 1 });
      } finally {
        await b2.close();
      }
    } finally {
      await b.close();
    }
  });
});

describe("L2: a reserved write that fails in Redis is refunded", () => {
  test("slice A dev plan: WRONGTYPE writes and failed pipeline writes are not billed", async () => {
    const plans = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
    for (const id of ["dev", "pro"]) {
      const redis = createMemoryRedis();
      const plan = { grace_ratio: plans.grace_ratio, ...plans.plans[id], id };
      const b = await startBridge({ redis, meter: { meter: sliceA.meter, checkQuota: sliceA.checkQuota }, plan });
      try {
        assert.equal((await b.exec(["SADD", K("s"), "x"])).status, 200);
        assert.equal((await b.exec(["INCR", K("s")])).status, 400); // WRONGTYPE
        const p = await b.pipe([["SET", K("ok"), "1"], ["INCR", K("s")], ["GET", K("ok")]]);
        assert.equal(p.status, 200);
        assert.match(p.body[1].error, /WRONGTYPE/);
        const u = await sliceA.usage(redis, TENANT);
        assert.equal(u.add, 2, `${id}: SADD + SET billed, the two failed INCRs refunded`);
        assert.equal(u.read, 1);
        assert.equal(u.ops_total, 3);
      } finally {
        await b.close();
      }
    }
  });

  test("a meter-supplied refund() is used; a refund error is logged, not surfaced", async () => {
    const refunds = [];
    const meter = { meter: async () => {}, checkQuota: async () => ({ ok: true, reserved: true }), refund: async (_r, _t, op, n) => { refunds.push([op, n]); throw new Error("x"); } };
    const b = await startBridge({ redis: async () => { throw new Error("WRONGTYPE no"); }, meter, plan: { limits: { add: 9 } } });
    try {
      const r = await b.exec(["DEL", K("a"), K("b")]);
      assert.deepEqual(r.body, { error: "WRONGTYPE command failed" });
      assert.deepEqual(refunds, [["add", 2]]);
      assert.ok(b.logs.some((l) => l.op === "refund" && !l.ok));
    } finally {
      await b.close();
    }
  });
});

describe("L3: oversized uploads see the 413", () => {
  test("declared Content-Length over the limit: always a 413, never a reset (20 runs)", async () => {
    const b = await startBridge();
    try {
      const big = JSON.stringify(["SET", K("big"), "x".repeat(DEFAULT_LIMITS.maxBodyBytes + 10)]);
      for (let i = 0; i < 20; i++) {
        const r = await b.call("/exec", null, { raw: big });
        assert.equal(r.status, 413, `run ${i}`);
        assert.deepEqual(r.body, { error: "payload_too_large" });
      }
      assert.equal(await b.redis("GET", K("big")), null);
    } finally {
      await b.close();
    }
  });

  test("an unbounded upload is cut off after the drain cap", { timeout: 15_000 }, async () => {
    const b = await startBridge();
    try {
      const { port } = new URL(b.base);
      const result = await new Promise((resolve) => {
        const sock = net.connect(Number(port), "127.0.0.1");
        let got = "";
        sock.on("data", (d) => (got += d));
        sock.on("error", () => {});
        sock.on("close", () => resolve(got));
        sock.write(`POST /exec HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 999999999\r\n\r\n`);
        const chunk = Buffer.alloc(256 * 1024, 120);
        const pump = () => { while (!sock.destroyed && sock.write(chunk)); if (!sock.destroyed) sock.once("drain", pump); };
        pump();
      });
      assert.match(result, /^HTTP\/1\.1 413/);
    } finally {
      await b.close();
    }
  });
});

describe("L4: deadlines, in-flight cap, failed-auth rate limit", () => {
  test("a hung upstream command times out (504) within commandTimeoutMs", async () => {
    const b = await startBridge({ redis: () => new Promise(() => {}), limits: { commandTimeoutMs: 100 } });
    try {
      const t0 = Date.now();
      const r = await b.exec(["GET", K("a")]);
      assert.equal(r.status, 504);
      assert.deepEqual(r.body, { error: "timeout" });
      assert.ok(Date.now() - t0 < 2000);
    } finally {
      await b.close();
    }
  });

  test("a pipeline stops at the request deadline; unrun writes are refunded, timed-out ones are not", async () => {
    let calls = 0;
    const redis = (...c) => { calls++; return c[0] === "SET" && c[1] === K("slow") ? new Promise(() => {}) : Promise.resolve("OK"); };
    const meter = fakeMeter();
    const b = await startBridge({ redis, meter, plan: { name: "p" }, limits: { requestDeadlineMs: 300, commandTimeoutMs: 1000 } });
    try {
      const t0 = Date.now();
      const r = await b.pipe([["SET", K("a"), "1"], ["SET", K("slow"), "1"], ["SET", K("b"), "1"], ["SET", K("c"), "1"]]);
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.map((x) => x.result ?? x.error), ["OK", "timeout", "timeout", "timeout"]);
      assert.equal(calls, 2, "commands after the deadline never ran");
      assert.equal(meter.used.add, 2, "4 admitted, 2 that never ran refunded; the timed-out one stays billed");
    } finally {
      await b.close();
    }
  });

  test("in-flight cap: requests over maxInFlight get 503 busy", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const b = await startBridge({ redis: () => gate.then(() => "OK"), limits: { maxInFlight: 2 } });
    try {
      const slow = [b.exec(["GET", K("a")]), b.exec(["GET", K("b")])];
      await new Promise((r) => setTimeout(r, 50));
      const r = await b.exec(["GET", K("c")]);
      assert.equal(r.status, 503);
      assert.deepEqual(r.body, { error: "busy" });
      release();
      assert.deepEqual((await Promise.all(slow)).map((x) => x.status), [200, 200]);
      assert.equal((await b.exec(["GET", K("d")])).status, 200, "slots are released");
    } finally {
      await b.close();
    }
  });

  test("failed auth is rate limited per source address; the right token still works", async () => {
    let now = 0;
    const b = await startBridge({ limits: { authFailBurst: 3, authFailPerSec: 1, now: () => now } });
    try {
      const st = [];
      for (let i = 0; i < 5; i++) st.push((await b.exec(["PING"], { token: "guess" + i })).status);
      assert.deepEqual(st, [401, 401, 401, 429, 429]);
      assert.equal((await b.exec(["PING"])).status, 200);
      now += 2000;
      assert.equal((await b.exec(["PING"], { token: "guess" })).status, 401, "refills");
    } finally {
      await b.close();
    }
  });
});

describe("L7: limits are validated at startup", () => {
  test("rate capacity below the largest pipeline or command is refused", () => {
    assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, rateCapacity: 50 }), /maxPipeline|maxKeys/);
    assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, rateCapacity: 500, maxKeys: 1000 }), /maxKeys/);
    assert.throws(() => validateLimits({ ...DEFAULT_LIMITS, maxInFlight: 0 }), /maxInFlight/);
    assert.throws(() => createBridge({ tenant: TENANT, tokenSha256: HASH, redis: createMemoryRedis(), limits: { rateCapacity: 99 } }));
    assert.throws(() => limitsFromEnv({ ACMI_BRIDGE_RATE_CAPACITY: "50" }), /rateCapacity/);
    assert.throws(() => limitsFromEnv({ ACMI_BRIDGE_RATE_CAPACITY: "abc" }), /positive/);
    assert.deepEqual(limitsFromEnv({ ACMI_BRIDGE_RATE_CAPACITY: "5000", ACMI_BRIDGE_RATE_PER_SEC: "100" }), { rateCapacity: 5000, rateRefillPerSec: 100 });
  });
});

// ---- deploy artifacts -----------------------------------------------------------------

describe("deploy artifacts", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  test("compose: one ingress mode (acmi-edge, no host port), per-tenant ACL URL, no secrets", () => {
    const c = read("../cloud/bridge/compose.template.yml");
    const live = c.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    assert.doesNotMatch(live, /^\s*ports:/m, "no host port by default");
    assert.match(live, /acmi-edge/);
    assert.match(live, /ACMI_REDIS_URL: "\$\{ACMI_REDIS_URL_\{\{TENANT_ENV\}\}:\?/);
    assert.doesNotMatch(live, /redis:\/\/[^$"]*:[^@$"]+@/, "no literal credentials");
    assert.doesNotMatch(c, /internal: true\s*$/m, "no claim the template cannot enforce");
  });

  test("ACL template: tenant user (data only) and meter user (own counters only), both reset-first", () => {
    const acl = read("../cloud/bridge/acl.template.txt");
    const rules = acl.split("\n").filter((l) => l.startsWith("user "));
    assert.equal(rules.length, 2);
    const [tenantRule, meterRule] = rules;
    for (const rule of rules) {
      // A2: `reset` first, so re-applying (rotation) replaces the user instead of merging into it
      assert.match(rule, /^user \S+ reset on #\{\{(METER_)?PASSWORD_SHA256\}\} resetkeys /);
      assert.match(rule, / resetchannels -@all /);
      assert.doesNotMatch(rule, /\+@|allkeys|allcommands|~\*|&\*|nopass|>/);
      assert.doesNotMatch(rule, /\+(eval|keys|flushall|flushdb|config|script|function|debug|acl|module|monitor|select|migrate|sort|object)\b/i);
    }
    // tenant user: its own data only; no meter keys, no EVALSHA (A1)
    assert.match(tenantRule, /^user acmi-t-\{\{TENANT\}\} reset on #\{\{PASSWORD_SHA256\}\} resetkeys ~acmi:t-\{\{TENANT\}\}:\* ~lm:t-\{\{TENANT\}\}:\* resetchannels /);
    assert.doesNotMatch(tenantRule, /meter|\+evalsha/);
    const granted = new Set([...tenantRule.matchAll(/\+([a-z]+)/g)].map((m) => m[1].toUpperCase()));
    assert.deepEqual([...granted].sort(), Object.keys(COMMANDS).sort(), "exactly the bridge command table");
    for (const c of DENIED) assert.ok(!granted.has(c), `tenant ACL grants denied ${c}`);
    // meter user: only this tenant's counters, only the meter's commands
    assert.match(meterRule, /^user acmi-meter-\{\{TENANT\}\} reset on #\{\{METER_PASSWORD_SHA256\}\} resetkeys ~acmi:cloud:meter:\{\{TENANT\}\}:\* resetchannels -@all /);
    const meterCmds = [...meterRule.matchAll(/\+([a-z]+)/g)].map((m) => m[1].toUpperCase()).sort();
    assert.deepEqual(meterCmds, ["EVALSHA", "EXPIRE", "GET", "INCRBY", "PING"]);
  });

  test("the ACL template, enforced by a fake Redis: tenant user cannot touch meter keys, meter user cannot touch data", async () => {
    const check = aclFromTemplate(TENANT);
    const month = utcMonth(Date.now());
    const meterKey = `acmi:cloud:meter:${TENANT}:${month}:add`;
    assert.equal(check("acmi-t-acme", ["SET", K("a"), "1"]), true);
    assert.equal(check("acmi-t-acme", ["INCRBY", meterKey, "-5"]), false, "no meter rewrite");
    assert.equal(check("acmi-t-acme", ["SET", meterKey, "0"]), false);
    assert.equal(check("acmi-t-acme", ["EVALSHA", "x", "2", meterKey, meterKey, "-5"]), false, "no EVALSHA");
    assert.equal(check("acmi-t-acme", ["GET", "acmi:t-other:a"]), false);
    assert.equal(check("acmi-meter-acme", ["INCRBY", meterKey, "1"]), true);
    assert.equal(check("acmi-meter-acme", ["EVALSHA", "x", "2", meterKey, meterKey.replace(":add", ":ops_total"), "1"]), true);
    assert.equal(check("acmi-meter-acme", ["INCRBY", `acmi:cloud:meter:other:${month}:add`, "-5"]), false, "other tenant's counters");
    assert.equal(check("acmi-meter-acme", ["GET", K("a")]), false, "no tenant data");
    assert.equal(check("acmi-meter-acme", ["SET", meterKey, "0"]), false, "no SET on counters");
    assert.equal(check("acmi-meter-acme", ["EVAL", "return 1", "0"]), false, "no EVAL");
  });

  test("Dockerfile installs nothing and copies only what the bridge needs; .dockerignore exists", () => {
    const d = read("../cloud/bridge/Dockerfile");
    assert.doesNotMatch(d, /npm (ci|install)/);
    const copies = [...d.matchAll(/^COPY (\S+)/gm)].map((m) => m[1]).sort();
    assert.deepEqual(copies, ["cloud/bridge", "cloud/meter", "cloud/plans.json", "cloud/tenants", "src/lib"].sort());
    assert.match(d, /^USER node$/m);
    const ig = read("../.dockerignore");
    for (const p of ["node_modules", ".env", ".git"]) assert.match(ig, new RegExp(`^${p.replace(".", "\\.")}`, "m"));
  });
});

// ---- main.mjs ------------------------------------------------------------------------

describe("main.mjs", () => {
  test("env parsing: plan JSON, plan name via plans.json, bad redis URL", async () => {
    const { planFromEnv, redisFromEnv, meterFromEnv } = await import("../cloud/bridge/main.mjs");
    assert.equal(planFromEnv({}), null);
    assert.deepEqual(planFromEnv({ ACMI_PLAN_QUOTAS: '{"limits":{"add":5}}' }), { limits: { add: 5 } });
    assert.equal(planFromEnv({ ACMI_PLAN_QUOTAS: "starter" }).id, "dev", "alias");
    assert.throws(() => planFromEnv({ ACMI_PLAN_QUOTAS: "{bad" }), /not valid JSON/);
    assert.throws(() => planFromEnv({ ACMI_PLAN_QUOTAS: "nope" }), /unknown plan/);
    await assert.rejects(() => redisFromEnv({ ACMI_REDIS_URL: "ftp://x" }), /must be redis/);
    await assert.rejects(() => redisFromEnv({ ACMI_REDIS_URL: "https://x" }), /ACMI_REDIS_TOKEN/);
    assert.equal((await redisFromEnv({ ACMI_REDIS_URL: "redis://127.0.0.1:1" })).kind, "resp");
    await assert.rejects(() => meterFromEnv({ ACMI_METER_MODULE: "/nonexistent/meter.mjs" }), /meter module failed/);
    const m = await meterFromEnv({});
    assert.equal(typeof m.meter, "function");
    assert.equal(m.reserveScript, sliceA.RESERVE_LUA);
  });

  const spawnMain = async (env) => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [new URL("../cloud/bridge/main.mjs", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    const ready = new Promise((resolve, reject) => {
      const t = setInterval(() => out.includes("listening") && (clearInterval(t), resolve()), 25);
      exited.then((c) => { clearInterval(t); reject(Object.assign(new Error(`exited ${c}`), { out: () => out })); });
    });
    return { child, ready, exited, out: () => out };
  };

  test("process smoke: two ACL users (tenant + meter), slice A meter, dev plan; no secrets in output", { timeout: 20_000 }, async () => {
    const PW = "acl_pw_SECRET_123";
    const MPW = "meter_pw_SECRET_456";
    const fake = await startFakeRedis({ users: { "acmi-t-acme": PW, "acmi-meter-acme": MPW }, acl: aclFromTemplate(TENANT) });
    const sha = sha1(sliceA.RESERVE_LUA);
    fake.scripts.set(sha, sliceA.RESERVE_LUA); // slice D's SCRIPT LOAD
    const port = 40000 + Math.floor(Math.random() * 20000);
    const p = await spawnMain({
      ACMI_TENANT: TENANT,
      ACMI_BRIDGE_TOKEN_SHA256: HASH,
      ACMI_REDIS_URL: fake.url(`acmi-t-acme:${PW}@`),
      ACMI_METER_REDIS_URL: fake.url(`acmi-meter-acme:${MPW}@`),
      ACMI_BRIDGE_PORT: String(port),
      ACMI_BRIDGE_HOST: "127.0.0.1",
      ACMI_PLAN_QUOTAS: "dev",
    });
    try {
      await p.ready;
      const r = createRedis({ url: `http://127.0.0.1:${port}/exec`, token: TOKEN });
      assert.equal(await r("SET", K("smoke"), "SMOKE_VALUE"), "OK");
      assert.equal(await r("GET", K("smoke")), "SMOKE_VALUE");
      assert.equal(await r("MSET", K("m1"), "1", K("m2"), "2"), "OK");
      assert.deepEqual(await r("MGET", K("m1"), K("m2")), ["1", "2"]);
      await assert.rejects(() => r("GET", "acmi:agent:x"), /HTTP 403/);
      const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.deepEqual(h, { ok: true, tenant: TENANT, version: h.version });
      const u = await sliceA.usage(fake.mem, TENANT);
      assert.equal(u.add, 3, "SET + MSET of 2, counted through the reserve script");
      assert.equal(u.read, 3, "GET + MGET of 2");
      assert.ok(fake.seen.some((c) => c[0] === "EVALSHA"), "meter used EVALSHA");
      assert.ok(!fake.seen.some((c) => c[0] === "EVAL"), "never EVAL");
      assert.doesNotMatch(p.out(), /"level":"warn"/, "the ACL split is in place, so no isolation warning");
      const out = p.out();
      for (const s2 of ["SMOKE_VALUE", HASH, PW, MPW, "acmi-t-acme", "acmi-meter-acme", String(fake.port)]) assert.ok(!out.includes(s2), `leaked ${s2}`);
    } finally {
      p.child.kill("SIGTERM");
      await p.exited;
      await fake.close();
    }
  });

  test("process: refuses to start without a meter URL on redis://, or when the meter self-test fails", { timeout: 20_000 }, async () => {
    const fake = await startFakeRedis({
      users: { "acmi-t-acme": "x", "acmi-meter-acme": "y" },
      deny: (c) => String(c[0]).toUpperCase() === "INCRBY" && String(c[1]).startsWith("acmi:cloud:"),
    });
    const base = {
      ACMI_TENANT: TENANT,
      ACMI_BRIDGE_TOKEN_SHA256: HASH,
      ACMI_REDIS_URL: fake.url("acmi-t-acme:x@"),
      ACMI_BRIDGE_HOST: "127.0.0.1",
      ACMI_PLAN_QUOTAS: "pro",
    };
    try {
      for (const [env, msg] of [
        [{}, /ACMI_METER_REDIS_URL is required/],
        [{ ACMI_METER_REDIS_URL: base.ACMI_REDIS_URL }, /must be a different Redis user/],
        [{ ACMI_METER_REDIS_URL: fake.url("acmi-meter-acme:y@") }, /"self-test failed: meter counter"/],
        [{ ACMI_METER_REDIS_URL: fake.url("acmi-meter-acme@") }, /ACMI_METER_REDIS_URL: invalid redis url user without password/],
        [{ ACMI_REDIS_URL: fake.url("acmi-t-acme@"), ACMI_METER_REDIS_URL: fake.url("acmi-meter-acme:y@") }, /ACMI_REDIS_URL: invalid redis url user without password/],
      ]) {
        const p = await spawnMain({ ...base, ACMI_BRIDGE_PORT: String(40000 + Math.floor(Math.random() * 20000)), ...env });
        await assert.rejects(() => p.ready);
        assert.equal(await p.exited, 1);
        assert.match(p.out(), msg);
        assert.ok(!/x@|y@|127\.0\.0\.1/.test(p.out()), "no URL in the fatal message");
      }
    } finally {
      await fake.close();
    }
  });
});

// ---- hardening before untrusted tenants (cloud/b-bridge-hardening) -------------------

describe("A1: the meter has its own connection and user; reserves need n >= 1", () => {
  test("meterRedisFromEnv: required on redis://, must differ from the tenant user, shared only on REST", async () => {
    const tenantResp = createRespRunner("redis://acmi-t-acme:a@127.0.0.1:1");
    await assert.rejects(() => meterRedisFromEnv({}, tenantResp), /ACMI_METER_REDIS_URL is required/);
    await assert.rejects(
      () => meterRedisFromEnv({ ACMI_REDIS_URL: "redis://acmi-t-acme:a@h:1", ACMI_METER_REDIS_URL: "redis://acmi-t-acme:a@h:1" }, tenantResp),
      /different Redis user/,
    );
    const m = await meterRedisFromEnv({ ACMI_REDIS_URL: "redis://acmi-t-acme:a@h:1", ACMI_METER_REDIS_URL: "redis://acmi-meter-acme:b@h:1" }, tenantResp);
    assert.notEqual(m, tenantResp);
    const rest = createRedis({ url: "http://127.0.0.1:1", token: "t" });
    assert.equal(await meterRedisFromEnv({}, rest), rest, "REST upstream: no ACL split possible, shared");
  });

  test("tenant commands and meter calls go over separate connections as separate users", async () => {
    const fake = await startFakeRedis({ users: { "acmi-t-acme": "a", "acmi-meter-acme": "b" }, acl: aclFromTemplate(TENANT) });
    fake.scripts.set(sha1(sliceA.RESERVE_LUA), sliceA.RESERVE_LUA);
    const tenantRedis = createRespRunner(fake.url("acmi-t-acme:a@"));
    const meterRedis = meterRunner(createRespRunner(fake.url("acmi-meter-acme:b@")));
    const plans = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
    const plan = { grace_ratio: plans.grace_ratio, ...plans.plans.dev, id: "dev" };
    const meter = {
      meter: (_r, ...a) => sliceA.meter(meterRedis, ...a),
      checkQuota: (_r, ...a) => sliceA.checkQuota(meterRedis, ...a),
    };
    const b = await startBridge({ redis: tenantRedis, meter, plan });
    try {
      assert.equal((await b.exec(["SET", K("a"), "1"])).status, 200);
      assert.equal((await b.exec(["GET", K("a")])).status, 200);
      assert.deepEqual(await sliceA.usage(fake.mem, TENANT), { month: utcMonth(Date.now()), add: 1, read: 1, recall: 0, ops_total: 2 });
      // the tenant user itself is refused on meter keys and EVALSHA
      const mk = `acmi:cloud:meter:${TENANT}:${utcMonth(Date.now())}:add`;
      await assert.rejects(() => tenantRedis("INCRBY", mk, -1), /NOPERM/);
      await assert.rejects(() => tenantRedis("EVALSHA", sha1(sliceA.RESERVE_LUA), 2, mk, mk, "-5", "0", "0", "1"), /NOPERM/);
      // and the self-test proves the split (no isolation warning) and still passes
      assert.deepEqual(await selfTest({ redis: tenantRedis, meterRedis, meter: { ...sliceA, reserveScript: sliceA.RESERVE_LUA, ttlSeconds: 60 }, plan, tenant: TENANT }), { metered: true });
    } finally {
      await b.close();
      await meterRedis.close();
      await tenantRedis.close();
      await fake.close();
    }
  });

  test("the reserve script refuses n < 1 (Lua text and its in-process twin)", async () => {
    assert.match(sliceA.RESERVE_LUA, /if not n or n < 1 or n ~= math\.floor\(n\) then return redis\.error_reply\("ERR invalid count"\) end/);
    const redis = createMemoryRedis();
    const k = `acmi:cloud:meter:${TENANT}:${utcMonth(Date.now())}`;
    await redis("SET", `${k}:add`, "10");
    for (const n of ["-5", "0", "1.5", "x"]) {
      await assert.rejects(() => redis("EVAL", sliceA.RESERVE_LUA, 2, `${k}:add`, `${k}:ops_total`, n, "100", "110", "60"), /ERR invalid count/, n);
    }
    assert.equal(await redis("GET", `${k}:add`), "10", "no decrement");
    const ok = await redis("EVAL", sliceA.RESERVE_LUA, 2, `${k}:add`, `${k}:ops_total`, "1", "100", "110", "60");
    assert.equal(Number(ok[0]), 1);
  });
});

describe("R1: reply size cap and an incremental parser", () => {
  test("a reply over maxReplyBytes fails the command and drops the connection", async () => {
    const big = Array.from({ length: 5000 }, (_, i) => `v${i}`);
    const fake = await startFakeRedis({ handle: async (cmd) => (cmd[0] === "LRANGE" ? big : "OK") });
    const r = createRespRunner(fake.url(), { maxReplyBytes: 16 * 1024 });
    try {
      await assert.rejects(() => r("LRANGE", K("l"), 0, -1), /^RespError: redis reply too large$/);
      assert.equal(await r("PING"), "OK", "reconnected on a fresh connection");
    } finally {
      await r.close();
      await fake.close();
    }
    const p = createParser({ maxReplyBytes: 100 });
    assert.throws(() => p.feed(Buffer.from("$200\r\n")), /too large/, "a bulk header over the cap fails before its bytes arrive");
    assert.throws(() => createParser({ maxReplyBytes: 100 }).feed(Buffer.from("*1000\r\n")), /too large/);
    assert.throws(() => createParser({ maxDepth: 4 }).feed(Buffer.from("*1\r\n".repeat(5))), /protocol/);
  });

  test("linear time: a 200k-element reply in 64 KB chunks parses in well under a second", () => {
    const parts = ["*200000\r\n"];
    for (let i = 0; i < 200000; i++) parts.push(`$7\r\nv${String(i).padStart(6, "0")}\r\n`);
    const wire = Buffer.from(parts.join(""));
    const p = createParser({ maxReplyBytes: 32 * 1024 * 1024 });
    const t0 = performance.now();
    let got = [];
    for (let i = 0; i < wire.length; i += 65536) got = got.concat(p.feed(wire.subarray(i, i + 65536)));
    const ms = performance.now() - t0;
    assert.equal(got.length, 1);
    assert.equal(got[0].length, 200000);
    assert.equal(got[0][199999], "v199999");
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    // a single 4 MB bulk in 1 KB chunks: collected, joined once
    const bulk = Buffer.concat([Buffer.from(`$${4 * 1024 * 1024}\r\n`), Buffer.alloc(4 * 1024 * 1024, 97), Buffer.from("\r\n")]);
    const q = createParser();
    const t1 = performance.now();
    let out = [];
    for (let i = 0; i < bulk.length; i += 1024) out = out.concat(q.feed(bulk.subarray(i, i + 1024)));
    assert.equal(out[0].length, 4 * 1024 * 1024);
    assert.ok(performance.now() - t1 < 1000);
  });
});

describe("R2: strict framing", () => {
  const bad = (wire) => assert.throws(() => createParser().feed(Buffer.from(wire)), /protocol error/, JSON.stringify(wire));
  test("bulk CRLF terminator is checked", () => {
    bad("$3\r\nabcXY:7\r\n");
    bad("$3\r\nabc\n\r");
    assert.deepEqual(createParser().feed(Buffer.from("$3\r\nabc\r\n:7\r\n")), ["abc", 7]);
  });
  test("lengths and integers: ASCII digits with an optional leading '-' only", () => {
    for (const t of ["$ 3\r\nabc\r\n", "$0x3\r\nabc\r\n", "$+3\r\nabc\r\n", "$3.0\r\nabc\r\n", "$3e0\r\nabc\r\n", "$\r\n", "$-2\r\n", "*-2\r\n", "* 1\r\n:1\r\n", ":1.5\r\n", ": 7\r\n", ":0x10\r\n", ":\r\n", "!3\r\nabc\r\n"]) bad(t);
    assert.deepEqual(createParser().feed(Buffer.from("$-1\r\n*-1\r\n:-7\r\n")), [null, null, -7]);
  });
  test("a reply nobody asked for drops the connection and fails what is in flight", async () => {
    let sockRef;
    const server = net.createServer((sock) => {
      sockRef = sock;
      sock.on("data", () => sock.write("+OK\r\n+INJECTED\r\n"));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    server.on("connection", (c) => c.on("error", () => {}));
    const r = createRespRunner(`redis://127.0.0.1:${server.address().port}`);
    try {
      // first command gets its OK, then the extra reply arrives with nobody waiting
      const first = await r("PING").catch((e) => e);
      assert.ok(first === "OK" || /protocol error/.test(first.message));
      await new Promise((res) => setTimeout(res, 50));
      assert.ok(sockRef.destroyed || sockRef.readableEnded || sockRef.closed, "connection dropped");
    } finally {
      await r.close();
      await new Promise((res) => server.close(res));
    }
  });
});

describe("R3: a user without a password is refused", () => {
  test("parseRedisUrl and createRespRunner refuse user@host, never fall back to the default user", () => {
    assert.throws(() => parseRedisUrl("redis://acmi-t-acme@redis:6379"), /user without password/);
    assert.throws(() => createRespRunner("redis://acmi-t-acme@redis:6379"), /user without password/);
    assert.equal(parseRedisUrl("redis://redis:6379").username, null, "no user at all is the explicit default-user case");
    assert.equal(parseRedisUrl("redis://:pw@redis:6379").password, "pw");
    assert.deepEqual(parseRedisUrl("redis://u:p%40ss@redis:6380/1"), { tls: false, host: "redis", port: 6380, username: "u", password: "p@ss", db: 1 });
  });
});

describe("R4: binary-safe values and big integers", () => {
  test("invalid UTF-8 comes back as {$base64}; valid UTF-8 as a string; ints over 2^53 as strings", async () => {
    assert.equal(BINARY_KEY, "$base64");
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
    const p = createParser();
    const out = p.feed(Buffer.concat([Buffer.from("*4\r\n$4\r\n"), raw, Buffer.from("\r\n$3\r\né!\r\n:9007199254740993\r\n:9007199254740991\r\n")]));
    assert.deepEqual(out, [[{ $base64: raw.toString("base64") }, "é!", "9007199254740993", 9007199254740991]]);
    // through the bridge, the marker survives JSON
    const fake = await startFakeRedis({ handle: async (cmd) => (cmd[0] === "GET" ? "x" : "OK") });
    const server = net.createServer((sock) => sock.on("data", () => sock.write(Buffer.concat([Buffer.from("$4\r\n"), raw, Buffer.from("\r\n")]))));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const runner = createRespRunner(`redis://127.0.0.1:${server.address().port}`);
    const b = await startBridge({ redis: runner });
    try {
      assert.deepEqual((await b.exec(["GET", K("bin")])).body, { result: { $base64: raw.toString("base64") } });
    } finally {
      await b.close();
      await runner.close();
      await new Promise((r) => server.close(r));
      await fake.close();
    }
  });
});

describe("F1: refunds only on a definite Redis refusal", () => {
  test("isServerRejection: error replies yes; timeouts, dropped connections, protocol errors no", () => {
    assert.equal(isServerRejection(new RespError("WRONGTYPE x", { server: true })), true);
    assert.equal(isServerRejection(new RespError("redis connection closed")), false);
    assert.equal(isServerRejection(new RespError("redis SET: timed out")), false);
    assert.equal(isServerRejection(new RespError("ERR looks like a reply", { server: false })), false);
    assert.equal(isServerRejection(new Error("WRONGTYPE Operation against a key")), true, "memory-redis style");
    assert.equal(isServerRejection(new Error("Redis REST SET: timed out after 5000ms")), false);
    assert.equal(isServerRejection(new Error("Redis REST SET: HTTP 502")), false);
    assert.equal(isServerRejection(null), false);
  });

  test("a dropped connection or timeout keeps the add counted (it may have landed); an error reply refunds", async () => {
    for (const [name, err, refunded] of [
      ["dropped", new RespError("redis connection closed"), false],
      ["timeout", new RespError("redis SET: timed out"), false],
      ["rejected", new RespError("WRONGTYPE no", { server: true }), true],
    ]) {
      const meter = fakeMeter();
      const b = await startBridge({ redis: async () => { throw err; }, meter, plan: { name: "p" } });
      try {
        await b.exec(["SET", K("a"), "1"]);
        assert.equal(meter.used.add, refunded ? 0 : 1, name);
        assert.equal((meter.calls.refund ?? []).length, refunded ? 1 : 0, name);
      } finally {
        await b.close();
      }
    }
  });

  test("end to end: resp.mjs drops a connection mid-pipeline; nothing refunded, every write stays counted", async () => {
    let n = 0;
    const server = net.createServer((sock) => sock.on("data", () => { if (++n === 1) sock.write("+OK\r\n"); else sock.destroy(); }));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const meter = fakeMeter();
    const runner = createRespRunner(`redis://127.0.0.1:${server.address().port}`);
    const b = await startBridge({ redis: runner, meter, plan: { name: "p" } });
    try {
      await b.exec(["SET", K("a"), "1"]);
      const r = await b.exec(["SET", K("b"), "1"]);
      assert.equal(r.status, 400);
      assert.equal(meter.used.add, 2);
      assert.equal((meter.calls.refund ?? []).length, 0);
    } finally {
      await b.close();
      await runner.close();
      await new Promise((res) => server.close(res));
    }
  });
});

describe("F2: in-flight slots are taken after auth", () => {
  const slowBadUpload = (port) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    sock.write("POST /exec HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer wrong\r\nContent-Length: 1000000\r\n\r\n");
    const iv = setInterval(() => !sock.destroyed && sock.write("x"), 20);
    sock.on("close", () => clearInterval(iv));
    return sock;
  };

  test("unauthenticated slow uploads never take the slots a valid request needs", async () => {
    const b = await startBridge({ limits: { maxInFlight: 2, maxUnauthInFlight: 8, authFailBurst: 100 } });
    const port = Number(new URL(b.base).port);
    const socks = Array.from({ length: 6 }, () => slowBadUpload(port));
    try {
      await new Promise((r) => setTimeout(r, 150));
      const r = await b.exec(["PING"]);
      assert.equal(r.status, 200, "valid request served while 6 unauthenticated uploads drain");
    } finally {
      for (const s2 of socks) s2.destroy();
      await b.close();
    }
  });

  test("the unauthenticated pool is small: over it, replies are sent and the socket closed at once (no drain)", async () => {
    const b = await startBridge({ limits: { maxUnauthInFlight: 2, authFailBurst: 100 } });
    const port = Number(new URL(b.base).port);
    const held = [slowBadUpload(port), slowBadUpload(port)];
    try {
      await new Promise((r) => setTimeout(r, 150));
      const t0 = Date.now();
      const third = await new Promise((resolve) => {
        const sock = slowBadUpload(port);
        let got = "";
        sock.on("data", (d) => (got += d));
        sock.on("close", () => resolve({ got, ms: Date.now() - t0 }));
      });
      assert.match(third.got, /^HTTP\/1\.1 401/);
      assert.ok(third.ms < 1000, `closed in ${third.ms} ms, not after the 2 s drain`);
      assert.ok(held.every((x) => !x.destroyed), "the first two are still draining");
    } finally {
      for (const s2 of held) s2.destroy();
      await b.close();
    }
  });
});

describe("T1: the request deadline is deterministic", () => {
  test("after the deadline is hit, no later command runs (20 runs)", async () => {
    for (let i = 0; i < 20; i++) {
      let calls = 0;
      const redis = (...c) => { calls++; return c[1] === K("slow") ? new Promise(() => {}) : Promise.resolve("OK"); };
      const meter = fakeMeter();
      const b = await startBridge({ redis, meter, plan: { name: "p" }, limits: { requestDeadlineMs: 40, commandTimeoutMs: 1000 } });
      try {
        const r = await b.pipe([["SET", K("a"), "1"], ["SET", K("slow"), "1"], ["SET", K("b"), "1"], ["SET", K("c"), "1"]]);
        assert.deepEqual(r.body.map((x) => x.result ?? x.error), ["OK", "timeout", "timeout", "timeout"], `run ${i}`);
        assert.equal(calls, 2, `run ${i}`);
        assert.equal(meter.used.add, 2, `run ${i}: the 2 never-run writes refunded`);
      } finally {
        await b.close();
      }
    }
  });
});
