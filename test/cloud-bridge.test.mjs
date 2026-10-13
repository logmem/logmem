// acmi-bridge (cloud slice B): jail, refusals, auth, limits, quota, logs, and
// redis-rest.mjs end to end through the bridge. In-memory Redis throughout.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createRedis } from "../src/lib/redis-rest.mjs";
import { probe } from "../scripts/bridge-probe.mjs";
import {
  createBridge, classify, keyArgs, checkCommand, tokenMatches, sha256Hex,
  COMMANDS, DENIED, DEFAULT_LIMITS, tenantPrefixes, genericRedisError,
} from "../cloud/bridge/bridge.mjs";

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
    assert.deepEqual(r.body, { error: "forbidden" });
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
  before(async () => { b = await startBridge(); });
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
      assert.ok([413, "EPIPE", "ECONNRESET"].includes(status), String(status));
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
    const b = await startBridge({ limits: { rateCapacity: 5, rateRefillPerSec: 1, now: () => now, maxPipeline: 10 } });
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

  test("refusing plan: checkQuota reserved the add, so meter() does not count it again", async () => {
    const counted = [];
    let checks = 0;
    const meter = {
      meter: async (_r, _t, op, n) => counted.push([op, n]),
      checkQuota: async (_r, _t, _op, _p, { n }) => { checks += n; return { ok: true, used: 0, limit: 10, grace: false }; },
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
    // An explicit {reserved} from the meter wins over the plan-shape inference.
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

// ---- main.mjs ------------------------------------------------------------------------

describe("main.mjs", () => {
  test("env parsing: plan JSON, plan name via plans.json, bad redis URL", async () => {
    const { planFromEnv, redisFromEnv, meterFromEnv } = await import("../cloud/bridge/main.mjs");
    assert.equal(planFromEnv({}), null);
    assert.deepEqual(planFromEnv({ ACMI_PLAN_QUOTAS: '{"limits":{"add":5}}' }), { limits: { add: 5 } });
    assert.throws(() => planFromEnv({ ACMI_PLAN_QUOTAS: "{bad" }), /not valid JSON/);
    await assert.rejects(() => redisFromEnv({ ACMI_REDIS_URL: "ftp://x" }), /must be redis/);
    await assert.rejects(() => redisFromEnv({ ACMI_REDIS_URL: "https://x" }), /ACMI_REDIS_TOKEN/);
    assert.equal(typeof (await redisFromEnv({ ACMI_REDIS_URL: "redis://127.0.0.1:1" })), "function");
    await assert.rejects(() => meterFromEnv({ ACMI_METER_MODULE: "/nonexistent/meter.mjs" }), /meter module failed/);
  });

  test("process smoke: main.mjs serves through an http(s) upstream and never logs secrets", { timeout: 20_000 }, async () => {
    const { spawn } = await import("node:child_process");
    const UP = "upstream_token_for_test_abcdef";
    const upstream = await startBridge({ tokenSha256: sha256Hex(UP) });
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [new URL("../cloud/bridge/main.mjs", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH,
        ACMI_TENANT: TENANT,
        ACMI_BRIDGE_TOKEN_SHA256: HASH,
        ACMI_REDIS_URL: `${upstream.base}/exec`,
        ACMI_REDIS_TOKEN: UP,
        ACMI_BRIDGE_PORT: String(port),
        ACMI_BRIDGE_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
      await new Promise((resolve, reject) => {
        const t = setInterval(() => out.includes("listening") && (clearInterval(t), resolve()), 25);
        child.on("exit", (c) => { clearInterval(t); reject(new Error(`exited ${c}: ${out}`)); });
      });
      const r = createRedis({ url: `http://127.0.0.1:${port}/exec`, token: TOKEN });
      assert.equal(await r("SET", K("smoke"), "SMOKE_VALUE"), "OK");
      assert.equal(await r("GET", K("smoke")), "SMOKE_VALUE");
      await assert.rejects(() => r("GET", "acmi:other:x"), /HTTP 403/);
      const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      assert.deepEqual(h, { ok: true, tenant: TENANT, version: h.version });
      assert.ok(!out.includes("SMOKE_VALUE") && !out.includes(HASH) && !out.includes(UP) && !out.includes(upstream.base), out);
    } finally {
      child.kill("SIGTERM");
      await upstream.close();
    }
  });
});
