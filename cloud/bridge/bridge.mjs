// acmi-bridge: a jailed, per-tenant Redis REST bridge (ACMI Cloud, slice B).
//
// One process per tenant. It speaks the Upstash REST shape the fleet already
// uses (POST / or /exec with a JSON command array, POST /pipeline with an array
// of commands), so src/lib/redis-rest.mjs and ACMI's Upstash adapter work
// against it unchanged.
//
// Security model (docs/cloud/BACKPLANE.md, Rules 4-6):
//   - auth: Authorization: Bearer <token>; sha256(token) is compared in
//     constant time with the configured hash. The token itself is never held.
//   - jail: every key argument, resolved per command from COMMANDS, must start
//     with `acmi:t-{tenant}:` or `lm:t-{tenant}:`. Unknown commands are refused.
//     SCAN gets a forced tenant MATCH; KEYS and admin/script commands are refused.
//   - limits: body, per-argument size, pipeline length, per-token token bucket.
//   - errors are generic and never echo keys, values or tokens.
//   - logs are JSON lines with tenant, op, cmd, ok and ms only.
//
// Zero runtime dependencies: node:crypto only. The HTTP server lives in main.mjs.

import { createHash, timingSafeEqual } from "node:crypto";

export const VERSION = "0.1.0";

export const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 1024 * 1024, // 1 MB
  maxValueBytes: 512 * 1024, // 512 KB per argument
  maxPipeline: 100,
  rateCapacity: 200, // bucket size (commands); must be >= maxPipeline
  rateRefillPerSec: 100, // commands per second, sustained
});

export const TENANT_RE = /^[a-z][a-z0-9-]{2,30}$/;
// Reserved ids are the registry's job (cloud/tenants). The bridge's guarantee
// does not depend on them: every tenant lives under the `t-` segment, which no
// fleet or system tree uses (BACKPLANE.md Rule 4), so even a tenant named
// `agent` or `cloud` can never reach acmi:agent:* or acmi:cloud:meter:*.

// ---- command table ------------------------------------------------------------
//
// Each entry: [op, keySpec]. op is "add" (any write) or "read".
// keySpec says where the key arguments are (indices are into the args after
// the command name):
//   "one"      args[0]
//   "two"      args[0], args[1]                      (RENAME, SMOVE, LMOVE, ...)
//   "all"      every arg                              (DEL, MGET, EXISTS, SINTER, ...)
//   "pairs"    args[0], args[2], args[4], ...        (MSET k v k v)
//   "destnum"  args[0] + numkeys at args[1]           (ZUNIONSTORE dest n k1..kn)
//   "num"      numkeys at args[0]                     (ZUNION n k1..kn)
//   "none"     no keys                                (PING)
//   "scan"     no keys; MATCH is forced to the tenant prefix
//   "copy"     args[0], args[1]; DB option refused (cross-db write)
//
// Coverage: every command src/, api/ and scripts/bridge-probe.mjs send, plus
// the common read/write and multi-key commands. Anything else is refused.

const T = (op, spec) => Object.freeze({ op, spec });

export const COMMANDS = Object.freeze({
  // connection
  PING: T("read", "none"),

  // keyspace
  DEL: T("add", "all"),
  UNLINK: T("add", "all"),
  EXISTS: T("read", "all"),
  TOUCH: T("read", "all"),
  TYPE: T("read", "one"),
  TTL: T("read", "one"),
  PTTL: T("read", "one"),
  EXPIRE: T("add", "one"),
  PEXPIRE: T("add", "one"),
  EXPIREAT: T("add", "one"),
  PEXPIREAT: T("add", "one"),
  PERSIST: T("add", "one"),
  RENAME: T("add", "two"),
  RENAMENX: T("add", "two"),
  COPY: T("add", "copy"),
  SCAN: T("read", "scan"),

  // strings
  GET: T("read", "one"),
  GETRANGE: T("read", "one"),
  STRLEN: T("read", "one"),
  MGET: T("read", "all"),
  SET: T("add", "one"),
  SETNX: T("add", "one"),
  SETEX: T("add", "one"),
  PSETEX: T("add", "one"),
  SETRANGE: T("add", "one"),
  GETSET: T("add", "one"),
  GETDEL: T("add", "one"),
  GETEX: T("add", "one"),
  APPEND: T("add", "one"),
  INCR: T("add", "one"),
  INCRBY: T("add", "one"),
  INCRBYFLOAT: T("add", "one"),
  DECR: T("add", "one"),
  DECRBY: T("add", "one"),
  MSET: T("add", "pairs"),
  MSETNX: T("add", "pairs"),

  // hashes
  HGET: T("read", "one"),
  HMGET: T("read", "one"),
  HGETALL: T("read", "one"),
  HKEYS: T("read", "one"),
  HVALS: T("read", "one"),
  HLEN: T("read", "one"),
  HEXISTS: T("read", "one"),
  HSTRLEN: T("read", "one"),
  HSCAN: T("read", "one"),
  HSET: T("add", "one"),
  HSETNX: T("add", "one"),
  HMSET: T("add", "one"),
  HDEL: T("add", "one"),
  HINCRBY: T("add", "one"),
  HINCRBYFLOAT: T("add", "one"),

  // lists
  LRANGE: T("read", "one"),
  LLEN: T("read", "one"),
  LINDEX: T("read", "one"),
  LPOS: T("read", "one"),
  LPUSH: T("add", "one"),
  RPUSH: T("add", "one"),
  LPUSHX: T("add", "one"),
  RPUSHX: T("add", "one"),
  LPOP: T("add", "one"),
  RPOP: T("add", "one"),
  LSET: T("add", "one"),
  LREM: T("add", "one"),
  LTRIM: T("add", "one"),
  LINSERT: T("add", "one"),
  RPOPLPUSH: T("add", "two"),
  LMOVE: T("add", "two"),

  // sets
  SMEMBERS: T("read", "one"),
  SISMEMBER: T("read", "one"),
  SMISMEMBER: T("read", "one"),
  SCARD: T("read", "one"),
  SRANDMEMBER: T("read", "one"),
  SSCAN: T("read", "one"),
  SINTER: T("read", "all"),
  SUNION: T("read", "all"),
  SDIFF: T("read", "all"),
  SADD: T("add", "one"),
  SREM: T("add", "one"),
  SPOP: T("add", "one"),
  SMOVE: T("add", "two"),
  SINTERSTORE: T("add", "all"),
  SUNIONSTORE: T("add", "all"),
  SDIFFSTORE: T("add", "all"),

  // sorted sets
  ZRANGE: T("read", "one"),
  ZREVRANGE: T("read", "one"),
  ZRANGEBYSCORE: T("read", "one"),
  ZREVRANGEBYSCORE: T("read", "one"),
  ZRANGEBYLEX: T("read", "one"),
  ZREVRANGEBYLEX: T("read", "one"),
  ZCARD: T("read", "one"),
  ZSCORE: T("read", "one"),
  ZMSCORE: T("read", "one"),
  ZRANK: T("read", "one"),
  ZREVRANK: T("read", "one"),
  ZCOUNT: T("read", "one"),
  ZLEXCOUNT: T("read", "one"),
  ZRANDMEMBER: T("read", "one"),
  ZSCAN: T("read", "one"),
  ZUNION: T("read", "num"),
  ZINTER: T("read", "num"),
  ZDIFF: T("read", "num"),
  ZADD: T("add", "one"),
  ZREM: T("add", "one"),
  ZINCRBY: T("add", "one"),
  ZPOPMIN: T("add", "one"),
  ZPOPMAX: T("add", "one"),
  ZREMRANGEBYSCORE: T("add", "one"),
  ZREMRANGEBYRANK: T("add", "one"),
  ZREMRANGEBYLEX: T("add", "one"),
  ZUNIONSTORE: T("add", "destnum"),
  ZINTERSTORE: T("add", "destnum"),
  ZDIFFSTORE: T("add", "destnum"),
  ZRANGESTORE: T("add", "two"),

  // streams (the recall outbox may use one)
  XADD: T("add", "one"),
  XDEL: T("add", "one"),
  XTRIM: T("add", "one"),
  XLEN: T("read", "one"),
  XRANGE: T("read", "one"),
  XREVRANGE: T("read", "one"),
});

// Refused outright, named here so the refusal is explicit and tested. Every
// command not in COMMANDS is refused too; this list is documentation + tests.
export const DENIED = Object.freeze(new Set([
  "EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "SCRIPT", "FUNCTION", "FCALL", "FCALL_RO",
  "FLUSHDB", "FLUSHALL", "CONFIG", "CLIENT", "MODULE", "MONITOR", "SELECT", "MIGRATE",
  "DEBUG", "SHUTDOWN", "REPLICAOF", "SLAVEOF", "ACL", "OBJECT", "SAVE", "BGSAVE",
  "BGREWRITEAOF", "KEYS", "SWAPDB", "MOVE", "SYNC", "PSYNC", "AUTH", "HELLO", "INFO",
  "DBSIZE", "RANDOMKEY", "SORT", "SORT_RO", "MULTI", "EXEC", "WATCH", "UNWATCH",
  "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "PUBLISH", "SPUBLISH", "PUBSUB", "WAIT",
  "DUMP", "RESTORE", "LASTSAVE", "SLOWLOG", "LATENCY", "MEMORY", "CLUSTER", "COMMAND",
  "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP",
  "XREAD", "XREADGROUP", "GEORADIUS", "GEORADIUSBYMEMBER",
]));

// ---- classification -----------------------------------------------------------

/** Upper-cased command name if it is a non-empty string, else null. */
function cmdName(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== "string") return null;
  return cmd[0].toUpperCase();
}

function entry(cmd) {
  const name = cmdName(cmd);
  if (!name || DENIED.has(name) || !Object.hasOwn(COMMANDS, name)) return null;
  return COMMANDS[name];
}

/** "add" | "read" | null. null means the bridge refuses this command. */
export function classify(cmd) {
  return entry(cmd)?.op ?? null;
}

const isInt = (v) => /^-?\d{1,18}$/.test(String(v));

// Trailing options allowed after the keys of ZUNION/ZINTER/ZDIFF(STORE).
// Anything else there is refused, so a caller cannot slip an extra key past a
// short numkeys.
function checkSetOpTail(tail, numkeys) {
  for (let i = 0; i < tail.length; ) {
    const t = String(tail[i]).toUpperCase();
    if (t === "WEIGHTS") {
      const w = tail.slice(i + 1, i + 1 + numkeys);
      if (w.length !== numkeys || !w.every((x) => /^-?\d+(\.\d+)?$/.test(String(x)))) return false;
      i += 1 + numkeys;
    } else if (t === "AGGREGATE") {
      if (!["SUM", "MIN", "MAX"].includes(String(tail[i + 1]).toUpperCase())) return false;
      i += 2;
    } else if (t === "WITHSCORES") {
      i += 1;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * The key arguments of a command, as strings in argument order. Returns null
 * when the command is refused or malformed (wrong arity, bad numkeys, unknown
 * trailing options). Returns [] for commands with no keys (PING, SCAN).
 */
function resolveKeys(cmd) {
  const e = entry(cmd);
  if (!e) return null;
  const args = cmd.slice(1);
  switch (e.spec) {
    case "none":
    case "scan":
      return [];
    case "one":
      return args.length >= 1 ? [args[0]] : null;
    case "two":
      return args.length >= 2 ? [args[0], args[1]] : null;
    case "copy": {
      if (args.length < 2) return null;
      // COPY src dst [DB n] [REPLACE]: DB would write outside this database.
      const opts = args.slice(2).map((a) => String(a).toUpperCase());
      if (!opts.every((o) => o === "REPLACE")) return null;
      return [args[0], args[1]];
    }
    case "all":
      return args.length >= 1 ? args.slice() : null;
    case "pairs": {
      if (args.length < 2 || args.length % 2 !== 0) return null;
      return args.filter((_, i) => i % 2 === 0);
    }
    case "destnum":
    case "num": {
      const off = e.spec === "destnum" ? 1 : 0;
      const nk = args[off];
      if (!isInt(nk) || Number(nk) < 1) return null;
      const n = Number(nk);
      const keys = args.slice(off + 1, off + 1 + n);
      if (keys.length !== n) return null;
      if (!checkSetOpTail(args.slice(off + 1 + n), n)) return null;
      return e.spec === "destnum" ? [args[0], ...keys] : keys;
    }
    default:
      return null;
  }
}

/** The key arguments of a command (empty for refused or keyless commands). */
export function keyArgs(cmd) {
  return resolveKeys(cmd) ?? [];
}

// ---- jail ---------------------------------------------------------------------

/**
 * Tenant namespace = `t-{id}` (BACKPLANE.md Rule 4). Computed the same way as
 * cloud/tenants keyPrefixes(id), without importing it (the bridge has no deps).
 */
export function tenantNamespace(tenant) {
  return `t-${tenant}`;
}

export function tenantPrefixes(tenant) {
  const ns = tenantNamespace(tenant);
  return [`acmi:${ns}:`, `lm:${ns}:`];
}

// A configured prefix must be literal (no glob metacharacters, so a SCAN MATCH
// that starts with it cannot widen), end with ":" and sit under the t- segment.
const PREFIX_RE = /^(acmi|lm):t-[a-z][a-z0-9-]{2,30}:$/;

/** True when `key` is a string strictly inside one of the tenant prefixes. */
export function inJail(key, prefixes) {
  if (typeof key !== "string") return false;
  return prefixes.some((p) => key.length > p.length && key.startsWith(p));
}

/**
 * Rewrite SCAN so it can only see the tenant's keys.
 *   SCAN cursor [MATCH pattern] [COUNT n] [TYPE t]
 * No MATCH: force MATCH acmi:t-{tenant}:*. A MATCH must begin with a tenant
 * prefix (the prefix holds no glob metacharacters, so a pattern that starts
 * with it can only match keys inside it). Anything else is refused.
 * Option words are normalised to upper case, which the native client needs.
 */
function jailScan(cmd, prefixes) {
  const args = cmd.slice(1);
  if (args.length < 1 || !/^\d{1,20}$/.test(String(args[0]))) return null;
  const out = ["SCAN", String(args[0])];
  let match = null;
  for (let i = 1; i < args.length; i += 2) {
    const opt = String(args[i]).toUpperCase();
    const val = args[i + 1];
    if (val === undefined) return null;
    if (opt === "MATCH") {
      if (match !== null || typeof val !== "string") return null;
      if (!prefixes.some((p) => val.startsWith(p))) return null;
      match = val;
    } else if (opt === "COUNT") {
      if (!/^\d{1,6}$/.test(String(val)) || Number(val) < 1) return null;
      out.push("COUNT", String(val));
    } else if (opt === "TYPE") {
      if (!/^[a-z]{3,10}$/i.test(String(val))) return null;
      out.push("TYPE", String(val));
    } else {
      return null;
    }
  }
  out.splice(2, 0, "MATCH", match ?? `${prefixes[0]}*`);
  return out;
}

/**
 * Validate one command against the jail and limits. Returns
 *   { ok: true, op, name, cmd }   cmd is what gets sent to Redis
 *   { ok: false, status, error }  generic; never names a key or value
 */
export function checkCommand(cmd, { prefixes, maxValueBytes }) {
  if (!Array.isArray(cmd) || cmd.length === 0) return refuse(400, "bad_request");
  for (const a of cmd) {
    if (typeof a === "string") {
      if (Buffer.byteLength(a) > maxValueBytes) return refuse(413, "value_too_large");
    } else if (typeof a !== "number" || !Number.isFinite(a)) {
      return refuse(400, "bad_request");
    }
  }
  const name = cmdName(cmd);
  const e = entry(cmd);
  if (!name || !e) return refuse(403, "forbidden");
  if (e.spec === "scan") {
    const scan = jailScan(cmd, prefixes);
    return scan ? { ok: true, op: e.op, name, cmd: scan } : refuse(403, "forbidden");
  }
  const keys = resolveKeys(cmd);
  if (!keys) return refuse(403, "forbidden");
  if (!keys.every((k) => inJail(k, prefixes))) return refuse(403, "forbidden");
  return { ok: true, op: e.op, name, cmd: [name, ...cmd.slice(1)] };
}

function refuse(status, error) {
  return { ok: false, status, error };
}

// ---- auth ---------------------------------------------------------------------

export function sha256Hex(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

/**
 * Constant-time check of a bearer token against the expected sha256 (hex).
 * Both sides are 32-byte digests, so length never leaks and timingSafeEqual
 * never throws on a length mismatch.
 */
export function tokenMatches(token, expectedHex) {
  if (typeof token !== "string" || token.length === 0) return false;
  const got = createHash("sha256").update(token).digest();
  const want = Buffer.from(expectedHex, "hex");
  if (want.length !== got.length) return false;
  return timingSafeEqual(got, want);
}

function bearer(req) {
  const h = req.headers?.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer[ ]+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// ---- rate limit ---------------------------------------------------------------

export function createBucket({ capacity, refillPerSec, now = () => Date.now() }) {
  let tokens = capacity;
  let last = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSec);
      last = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

// ---- errors from Redis ----------------------------------------------------------

/**
 * Redis error messages can quote arguments ("unknown command 'x', with args
 * beginning with: 'key'"). Keep only the leading error class.
 */
export function genericRedisError(e) {
  const m = /^([A-Z]{2,20})\b/.exec(String(e?.message ?? ""));
  const cls = m && m[1] !== "ERR" && /^(WRONGTYPE|NOSCRIPT|BUSY|LOADING|OOM|READONLY|NOPERM|EXECABORT)$/.test(m[1]) ? m[1] : "ERR";
  return `${cls} command failed`;
}

// ---- quota helpers --------------------------------------------------------------

/**
 * Does checkQuota itself count adds for this plan? True for a refusing plan
 * (finite add limit, no billed overage), where slice A's checkQuota is an
 * atomic reserve. A meter can say so explicitly with {reserved: boolean}.
 */
export function reservesOnCheck(plan) {
  if (!plan || typeof plan !== "object") return false;
  const lim = plan.limits?.add;
  if (lim === null || lim === undefined || !Number.isFinite(Number(lim))) return false;
  return !(plan.overage && plan.overage.billed === true);
}

// ---- bridge -------------------------------------------------------------------

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function send(res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

/**
 * Read the request body up to `limit` bytes. Resolves null as soon as the body
 * is known to be over the limit (declared or streamed); the caller answers 413
 * and closes the connection instead of draining an unbounded upload.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return resolve(null);
    const chunks = [];
    let size = 0;
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.off("data", onData);
        req.pause();
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Answer, then drop the connection. The rest of the upload is discarded (not
 * buffered) for at most CLOSE_GRACE_MS so the client can read the reply, then
 * the socket is destroyed: an unbounded upload cannot hold the bridge.
 */
const CLOSE_GRACE_MS = 1000;
function sendAndClose(req, res, status, body) {
  res.setHeader("Connection", "close");
  res.on("finish", () => {
    req.on("data", () => {});
    req.resume();
    setTimeout(() => req.socket?.destroy(), CLOSE_GRACE_MS).unref();
  });
  send(res, status, body);
}

function defaultLog(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Build a bridge for one tenant.
 *   tenant       bare tenant id (TENANT_RE); keys live under acmi:t-{id}: and lm:t-{id}:
 *   prefixes     optional subset of tenantPrefixes(tenant) (default: both)
 *   tokenSha256  hex sha256 of the bridge token (the token is never passed)
 *   redis        (...cmd) => Promise<result>, the canonical store
 *   meter        { meter(redis, tenant, op, n), checkQuota(redis, tenant, op, plan, {n}) } or null
 *   plan         plan object/name handed to checkQuota
 *   limits       overrides for DEFAULT_LIMITS, plus now() for tests
 *   log          (line) => void; receives {tenant, op, cmd, ok, ms}
 */
export function createBridge({ tenant, tokenSha256, redis, meter = null, plan = null, limits = {}, prefixes: configured = null, log = defaultLog }) {
  if (typeof tenant !== "string" || !TENANT_RE.test(tenant)) {
    throw new Error("acmi-bridge: invalid tenant id");
  }
  const own = tenantPrefixes(tenant);
  const prefixes = configured ?? own;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || !prefixes.every((p) => typeof p === "string" && PREFIX_RE.test(p) && own.includes(p))) {
    throw new Error("acmi-bridge: prefixes must be this tenant's acmi:t-{id}: / lm:t-{id}: namespace");
  }
  if (typeof tokenSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(tokenSha256)) {
    throw new Error("acmi-bridge: ACMI_BRIDGE_TOKEN_SHA256 must be 64 hex chars");
  }
  if (typeof redis !== "function") throw new Error("acmi-bridge: redis runner required");
  if (meter && (typeof meter.meter !== "function" || typeof meter.checkQuota !== "function")) {
    throw new Error("acmi-bridge: meter must provide meter() and checkQuota()");
  }
  const L = { ...DEFAULT_LIMITS, ...limits };
  const expected = tokenSha256.toLowerCase();
  const bucket = createBucket({ capacity: L.rateCapacity, refillPerSec: L.rateRefillPerSec, now: L.now });

  const emit = (op, cmd, ok, t0) => {
    try {
      log({ tenant, op, cmd, ok, ms: Math.round((performance.now() - t0) * 100) / 100 });
    } catch {
      /* logging never breaks a request */
    }
  };

  // Quota contract (cloud/meter, slice A):
  //   {ok:true}                          go (includes grace and billed overage: {ok:true, overage:true})
  //   {ok:false, code:"quota_exceeded"}  429 quota_exceeded
  //   anything else, or a throw          503 unavailable (fail closed for writes)
  // On a refusing plan, checkQuota already reserved the adds (atomic
  // check-and-increment), so meter() must not count them again.
  async function enforceQuota(adds) {
    if (!meter || adds === 0 || plan === null) return { ok: true, reserved: false };
    let q;
    try {
      q = await meter.checkQuota(redis, tenant, "add", plan, { n: adds });
    } catch {
      return { ok: false, status: 503, error: "unavailable" };
    }
    if (q?.ok === true) return { ok: true, reserved: typeof q.reserved === "boolean" ? q.reserved : reservesOnCheck(plan) };
    if (q?.ok === false && q.code === "quota_exceeded") return { ok: false, status: 429, error: "quota_exceeded" };
    return { ok: false, status: 503, error: "unavailable" };
  }

  async function count(adds, reads) {
    if (!meter) return;
    for (const [op, n] of [["add", adds], ["read", reads]]) {
      if (n <= 0) continue;
      try {
        await meter.meter(redis, tenant, op, n);
      } catch {
        emit("meter", null, false, performance.now());
      }
    }
  }

  async function run(checked) {
    const t0 = performance.now();
    try {
      const result = await redis(...checked.cmd);
      emit(checked.op, checked.name, true, t0);
      return { result: result === undefined ? null : result };
    } catch (e) {
      emit(checked.op, checked.name, false, t0);
      return { error: genericRedisError(e) };
    }
  }

  async function exec(body) {
    const t0 = performance.now();
    const c = checkCommand(body, { prefixes, maxValueBytes: L.maxValueBytes });
    if (!c.ok) {
      emit(classify(body) ?? "refused", cmdLabel(body), false, t0);
      return [c.status, { error: c.error }];
    }
    if (!bucket.take(1)) {
      emit(c.op, c.name, false, t0);
      return [429, { error: "rate_limited" }];
    }
    let reserved = false;
    if (c.op === "add") {
      const q = await enforceQuota(1);
      if (!q.ok) {
        emit(c.op, c.name, false, t0);
        return [q.status, { error: q.error }];
      }
      reserved = q.reserved;
    }
    const out = await run(c);
    if (!out.error) await count(c.op === "add" && !reserved ? 1 : 0, c.op === "read" ? 1 : 0);
    // Upstash answers a failed command with HTTP 400 and {error}.
    return [out.error ? 400 : 200, out];
  }

  async function pipeline(body) {
    if (!Array.isArray(body) || body.length === 0) return [400, { error: "bad_request" }];
    if (body.length > L.maxPipeline) return [413, { error: "pipeline_too_large" }];
    // All-or-nothing: check every command before running any.
    const checked = [];
    for (const cmd of body) {
      const c = checkCommand(cmd, { prefixes, maxValueBytes: L.maxValueBytes });
      if (!c.ok) return [c.status, { error: c.error }];
      checked.push(c);
    }
    if (!bucket.take(checked.length)) return [429, { error: "rate_limited" }];
    const adds = checked.filter((c) => c.op === "add").length;
    const q = await enforceQuota(adds);
    if (!q.ok) return [q.status, { error: q.error }];
    const results = [];
    let okAdds = 0;
    let okReads = 0;
    for (const c of checked) {
      const r = await run(c);
      results.push(r);
      if (!r.error) c.op === "add" ? okAdds++ : okReads++;
    }
    await count(q.reserved ? 0 : okAdds, okReads);
    return [200, results];
  }

  async function handler(req, res) {
    const t0 = performance.now();
    let path;
    try {
      path = new URL(req.url, "http://bridge").pathname;
    } catch {
      return send(res, 400, { error: "bad_request" });
    }

    if (path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, { ok: true, tenant, version: VERSION });
    }

    const isExec = path === "/" || path === "/exec";
    const isPipeline = path === "/pipeline";
    if (!isExec && !isPipeline) return send(res, 404, { error: "not_found" });
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

    if (!tokenMatches(bearer(req), expected)) {
      emit("auth", null, false, t0);
      return sendAndClose(req, res, 401, { error: "unauthorized" });
    }

    let raw;
    try {
      raw = await readBody(req, L.maxBodyBytes);
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    if (raw === null) {
      emit(isPipeline ? "pipeline" : "exec", null, false, t0);
      return sendAndClose(req, res, 413, { error: "payload_too_large" });
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, { error: "bad_request" });
    }

    try {
      if (isPipeline) {
        const [status, out] = await pipeline(body);
        if (status !== 200) emit("pipeline", null, false, t0);
        return send(res, status, out);
      }
      const [status, out] = await exec(body);
      return send(res, status, out);
    } catch {
      return send(res, 500, { error: "internal_error" });
    }
  }

  return {
    handler,
    async close() {
      if (typeof redis.close === "function") await redis.close();
    },
  };
}

/** Command name for logs: only names in the table, so a log never carries caller text. */
function cmdLabel(cmd) {
  const n = cmdName(cmd);
  return n && (Object.hasOwn(COMMANDS, n) || DENIED.has(n)) ? n : "?";
}
