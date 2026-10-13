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
  maxBodyBytes: 1024 * 1024, // 1 MB request body
  maxValueBytes: 512 * 1024, // 512 KB per argument
  maxCommandBytes: 1024 * 1024, // 1 MB across one command's arguments
  maxArgs: 2001, // arguments after the command name (1000 pairs + a key)
  maxKeys: 1000, // key arguments in one command (DEL, MGET, MSET, ...)
  maxScanCount: 1000, // COUNT for SCAN / HSCAN / SSCAN / ZSCAN
  maxPipeline: 100,
  // Token bucket, charged per key (a command costs max(1, keys); SCAN costs
  // ceil(COUNT/100)). Capacity must cover the largest single request.
  rateCapacity: 2000,
  rateRefillPerSec: 500,
  requestDeadlineMs: 10_000, // whole request, all commands
  commandTimeoutMs: 5_000, // one upstream command
  maxInFlight: 64, // concurrent requests being served
  authFailBurst: 10, // failed auths per source address before 429
  authFailPerSec: 1,
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
//   "scan"     no keys; MATCH is forced to the tenant prefix, COUNT capped
//   "kscan"    args[0]; HSCAN/SSCAN/ZSCAN options checked, COUNT capped
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
  HSCAN: T("read", "kscan"),
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
  SSCAN: T("read", "kscan"),
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
  ZSCAN: T("read", "kscan"),
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
    case "kscan":
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

const validCount = (v, max) => /^\d{1,7}$/.test(String(v)) && Number(v) >= 1 && Number(v) <= max;

/**
 * Rewrite SCAN so it can only see the tenant's keys.
 *   SCAN cursor [MATCH pattern] [COUNT n] [TYPE t]
 * No MATCH: force MATCH {first prefix}*. A MATCH must begin with a tenant
 * prefix (the prefix holds no glob metacharacters, so a pattern that starts
 * with it can only match keys inside it). COUNT is capped: MATCH filters what
 * comes back, not what Redis walks, and the keyspace is shared.
 * Option words are normalised to upper case.
 */
function jailScan(cmd, prefixes, maxCount) {
  const args = cmd.slice(1);
  if (args.length < 1 || !/^\d{1,20}$/.test(String(args[0]))) return null;
  const out = ["SCAN", String(args[0])];
  let match = null;
  let count = 10;
  for (let i = 1; i < args.length; i += 2) {
    const opt = String(args[i]).toUpperCase();
    const val = args[i + 1];
    if (val === undefined) return null;
    if (opt === "MATCH") {
      if (match !== null || typeof val !== "string") return null;
      if (!prefixes.some((p) => val.startsWith(p))) return null;
      match = val;
    } else if (opt === "COUNT") {
      if (!validCount(val, maxCount)) return null;
      count = Number(val);
      out.push("COUNT", String(val));
    } else if (opt === "TYPE") {
      if (!/^[a-z]{3,10}$/i.test(String(val))) return null;
      out.push("TYPE", String(val));
    } else {
      return null;
    }
  }
  out.splice(2, 0, "MATCH", match ?? `${prefixes[0]}*`);
  return { cmd: out, count };
}

/**
 * HSCAN / SSCAN / ZSCAN key cursor [MATCH p] [COUNT n] [NOVALUES (HSCAN)].
 * MATCH here filters fields/members inside the (jailed) key, so any pattern is
 * fine; COUNT is capped and unknown options are refused.
 */
function checkKeyScan(name, cmd, maxCount) {
  const args = cmd.slice(1);
  if (args.length < 2 || !/^\d{1,20}$/.test(String(args[1]))) return null;
  const out = [name, args[0], String(args[1])];
  let count = 10;
  for (let i = 2; i < args.length; ) {
    const opt = String(args[i]).toUpperCase();
    if (opt === "NOVALUES" && name === "HSCAN") {
      out.push("NOVALUES");
      i += 1;
      continue;
    }
    const val = args[i + 1];
    if (val === undefined) return null;
    if (opt === "MATCH" && typeof val === "string") out.push("MATCH", val);
    else if (opt === "COUNT" && validCount(val, maxCount)) {
      count = Number(val);
      out.push("COUNT", String(val));
    } else return null;
    i += 2;
  }
  return { cmd: out, count };
}

const scanCost = (count) => Math.max(1, Math.ceil(count / 100));

/**
 * Validate one command against the jail and limits. Returns
 *   { ok: true, op, name, cmd, weight }  cmd is what gets sent to Redis;
 *                                        weight is its cost in rate tokens and
 *                                        metered ops (max(1, key count))
 *   { ok: false, status, error }         generic; never names a key or value
 */
export function checkCommand(cmd, opts) {
  const L = { ...DEFAULT_LIMITS, ...opts };
  const { prefixes } = L;
  if (!Array.isArray(cmd) || cmd.length === 0) return refuse(400, "bad_request");
  if (cmd.length - 1 > L.maxArgs) return refuse(413, "too_many_arguments");
  let total = 0;
  for (const a of cmd) {
    if (typeof a === "string") {
      const n = Buffer.byteLength(a);
      if (n > L.maxValueBytes) return refuse(413, "value_too_large");
      total += n;
    } else if (typeof a === "number" && Number.isFinite(a)) {
      total += 24;
    } else {
      return refuse(400, "bad_request");
    }
  }
  if (total > L.maxCommandBytes) return refuse(413, "command_too_large");
  const name = cmdName(cmd);
  const e = entry(cmd);
  if (!name || !e) return refuse(403, "forbidden");
  if (e.spec === "scan") {
    const scan = jailScan(cmd, prefixes, L.maxScanCount);
    return scan ? { ok: true, op: e.op, name, cmd: scan.cmd, weight: scanCost(scan.count) } : refuse(403, "forbidden");
  }
  const keys = resolveKeys(cmd);
  if (!keys) return refuse(403, "forbidden");
  if (keys.length > L.maxKeys) return refuse(413, "too_many_keys");
  if (!keys.every((k) => inJail(k, prefixes))) return refuse(403, "forbidden");
  if (e.spec === "kscan") {
    const ks = checkKeyScan(name, cmd, L.maxScanCount);
    return ks ? { ok: true, op: e.op, name, cmd: ks.cmd, weight: scanCost(ks.count) } : refuse(403, "forbidden");
  }
  return { ok: true, op: e.op, name, cmd: [name, ...cmd.slice(1)], weight: Math.max(1, keys.length) };
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

/** Per-source buckets with a hard cap on how many sources are tracked. */
function createKeyedBuckets({ capacity, refillPerSec, now, maxKeys = 10_000 }) {
  const m = new Map();
  return {
    take(key, n = 1) {
      let b = m.get(key);
      if (!b) {
        if (m.size >= maxKeys) m.delete(m.keys().next().value);
        b = createBucket({ capacity, refillPerSec, now });
        m.set(key, b);
      }
      return b.take(n);
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
  const cls = m && /^(WRONGTYPE|NOSCRIPT|BUSY|LOADING|OOM|READONLY|NOPERM|EXECABORT)$/.test(m[1]) ? m[1] : "ERR";
  return `${cls} command failed`;
}

const TIMEOUT = Symbol("timeout");

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---- metering helpers ---------------------------------------------------------

/** "YYYYMM" in UTC, the same month key cloud/meter uses. */
export function utcMonth(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Default refund: take back `n` counted ops from the meter's counters for the
 * month the ops were counted in. Same key layout as cloud/meter
 * (acmi:cloud:meter:{tenant}:{yyyymm}:{op} and :ops_total). INCRBY with a
 * negative amount, so the ACL needs no extra command. A meter may supply its
 * own refund(redis, tenant, op, n, {now}).
 */
export async function defaultRefund(redis, tenant, op, n, { now }) {
  const base = `acmi:cloud:meter:${tenant}:${utcMonth(now)}`;
  await redis("INCRBY", `${base}:${op}`, -n);
  await redis("INCRBY", `${base}:ops_total`, -n);
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
 * is known to be over the limit (declared or streamed); nothing past the
 * limit is buffered.
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

// Answering before the upload is read: write the reply, keep discarding the
// rest of the upload (bounded) so the client is not reset mid-send and does
// see the status, then end and close the connection.
const DRAIN_MAX_BYTES = 4 * 1024 * 1024;
const DRAIN_MAX_MS = 2000;

function sendAndClose(req, res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "Content-Length": Buffer.byteLength(s), Connection: "close" });
  res.write(s);
  if (req.complete || req.readableEnded) return res.end();
  let drained = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.off("data", onData);
    res.end();
  };
  const onData = (c) => {
    drained += c.length;
    if (drained > DRAIN_MAX_BYTES) finish();
  };
  const timer = setTimeout(finish, DRAIN_MAX_MS);
  timer.unref?.();
  req.on("data", onData);
  req.once("end", finish);
  req.once("error", finish);
  req.once("close", finish);
  req.resume();
}

/** Refuse without draining: for floods (auth failures over the per-source cap, busy). */
function sendAndDestroy(req, res, status, body) {
  if (res.headersSent || res.writableEnded) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, "Content-Length": Buffer.byteLength(s), Connection: "close" });
  res.end(s, () => req.socket?.destroy());
}

function defaultLog(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Validate limits; a misconfigured bridge refuses to start rather than run
 * with a bucket that can never pay for a full pipeline or a full command.
 */
export function validateLimits(L) {
  const pos = ["maxBodyBytes", "maxValueBytes", "maxCommandBytes", "maxArgs", "maxKeys", "maxScanCount", "maxPipeline",
    "rateCapacity", "rateRefillPerSec", "requestDeadlineMs", "commandTimeoutMs", "maxInFlight", "authFailBurst", "authFailPerSec"];
  for (const k of pos) {
    if (!(typeof L[k] === "number" && Number.isFinite(L[k]) && L[k] > 0)) throw new Error(`acmi-bridge: limit ${k} must be a positive number`);
  }
  if (L.rateCapacity < L.maxPipeline) throw new Error("acmi-bridge: rateCapacity must be >= maxPipeline");
  if (L.rateCapacity < L.maxKeys) throw new Error("acmi-bridge: rateCapacity must be >= maxKeys");
  if (L.maxScanCount > 10_000) throw new Error("acmi-bridge: maxScanCount must be <= 10000");
  return L;
}

/**
 * Build a bridge for one tenant.
 *   tenant       bare tenant id (TENANT_RE); keys live under acmi:t-{id}: and lm:t-{id}:
 *   prefixes     optional subset of tenantPrefixes(tenant) (default: both)
 *   tokenSha256  hex sha256 of the bridge token (the token is never passed)
 *   redis        (...cmd) => Promise<result>, the canonical store
 *   meter        { meter(redis, tenant, op, n, {now}), checkQuota(redis, tenant, op, plan, {n, now}),
 *                  refund?(redis, tenant, op, n, {now}) } or null
 *   plan         plan object handed to checkQuota (null: count, never check)
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
  const L = validateLimits({ ...DEFAULT_LIMITS, ...limits });
  const now = L.now ?? (() => Date.now());
  const checkOpts = { ...L, prefixes };
  const expected = tokenSha256.toLowerCase();
  const bucket = createBucket({ capacity: L.rateCapacity, refillPerSec: L.rateRefillPerSec, now });
  const authFails = createKeyedBuckets({ capacity: L.authFailBurst, refillPerSec: L.authFailPerSec, now });
  const refund = typeof meter?.refund === "function" ? meter.refund : defaultRefund;
  let inFlight = 0;

  const emit = (op, cmd, ok, t0) => {
    try {
      log({ tenant, op, cmd, ok, ms: Math.round((performance.now() - t0) * 100) / 100 });
    } catch {
      /* logging never breaks a request */
    }
  };

  /**
   * Admit `adds` write ops before anything runs. Fails closed: any meter or
   * quota error refuses the writes (503); nothing is run uncounted.
   *   plan set:  checkQuota. {ok:true, reserved:true} means it already counted
   *              (refusing plan); otherwise meter() counts now.
   *   no plan:   meter() counts now.
   * Returns { ok:true, counted } or { ok:false, status, error }.
   */
  async function admitWrites(adds, at) {
    if (!meter || adds === 0) return { ok: true, counted: 0 };
    let reserved = false;
    if (plan !== null) {
      let q;
      try {
        q = await meter.checkQuota(redis, tenant, "add", plan, { n: adds, now: at });
      } catch {
        return { ok: false, status: 503, error: "unavailable" };
      }
      if (q?.ok === false && q.code === "quota_exceeded") return { ok: false, status: 429, error: "quota_exceeded" };
      if (q?.ok !== true) return { ok: false, status: 503, error: "unavailable" };
      reserved = q.reserved === true;
    }
    if (!reserved) {
      try {
        await meter.meter(redis, tenant, "add", adds, { now: at });
      } catch {
        emit("meter", null, false, performance.now());
        return { ok: false, status: 503, error: "unavailable" };
      }
    }
    return { ok: true, counted: adds };
  }

  async function settle(failedAdds, okReads, at) {
    if (!meter) return;
    if (failedAdds > 0) {
      try {
        await refund(redis, tenant, "add", failedAdds, { now: at });
      } catch {
        emit("refund", null, false, performance.now());
      }
    }
    if (okReads > 0) {
      // Reads are counted after the fact and never refused, even when counting fails.
      try {
        await meter.meter(redis, tenant, "read", okReads, { now: at });
      } catch {
        emit("meter", null, false, performance.now());
      }
    }
  }

  async function runOne(c, deadline) {
    const t0 = performance.now();
    const left = Math.min(L.commandTimeoutMs, deadline - performance.now());
    if (left <= 0) return { out: { error: "timeout" }, ran: false };
    let r;
    try {
      r = await withDeadline(redis(...c.cmd), left);
    } catch (e) {
      emit(c.op, c.name, false, t0);
      return { out: { error: genericRedisError(e) }, ran: true, failed: true };
    }
    if (r === TIMEOUT) {
      emit(c.op, c.name, false, t0);
      // Outcome unknown (the write may have landed): no refund.
      return { out: { error: "timeout" }, ran: true, failed: false, timedOut: true };
    }
    emit(c.op, c.name, true, t0);
    return { out: { result: r === undefined ? null : r }, ran: true, failed: false };
  }

  /**
   * Shared path for /exec (one command) and /pipeline. All-or-nothing on the
   * jail, size, rate and quota checks: if anything refuses, nothing runs and
   * the reply names the code (and, for a pipeline, the command index).
   */
  async function runRequest(cmds, isPipeline, t0) {
    const deadline = t0 + L.requestDeadlineMs;
    const checked = [];
    for (let i = 0; i < cmds.length; i++) {
      const c = checkCommand(cmds[i], checkOpts);
      if (!c.ok) {
        emit(classify(cmds[i]) ?? "refused", cmdLabel(cmds[i]), false, t0);
        return [c.status, isPipeline ? { error: c.error, index: i } : { error: c.error }];
      }
      checked.push(c);
    }
    const cost = checked.reduce((n, c) => n + c.weight, 0);
    if (!bucket.take(cost)) {
      emit(isPipeline ? "pipeline" : checked[0].op, isPipeline ? null : checked[0].name, false, t0);
      return [429, { error: "rate_limited" }];
    }
    const at = now();
    const adds = checked.reduce((n, c) => n + (c.op === "add" ? c.weight : 0), 0);
    const admit = await admitWrites(adds, at);
    if (!admit.ok) {
      const firstAdd = checked.findIndex((c) => c.op === "add");
      emit(isPipeline ? "pipeline" : "add", isPipeline ? null : checked[0].name, false, t0);
      return [admit.status, isPipeline ? { error: admit.error, index: firstAdd } : { error: admit.error }];
    }
    const results = [];
    let failedAdds = 0;
    let okReads = 0;
    for (const c of checked) {
      const r = await runOne(c, deadline);
      results.push(r.out);
      if (c.op === "add" && (r.failed || !r.ran)) failedAdds += c.weight;
      if (c.op === "read" && !r.out.error) okReads += c.weight;
    }
    await settle(admit.counted ? failedAdds : 0, okReads, at);
    if (isPipeline) return [200, results];
    const out = results[0];
    // Upstash answers a failed command with HTTP 400 and {error}.
    if (out.error === "timeout") return [504, out];
    return [out.error ? 400 : 200, out];
  }

  async function handler(req, res) {
    const t0 = performance.now();
    let path;
    try {
      path = new URL(req.url, "http://bridge").pathname;
    } catch {
      return sendAndClose(req, res, 400, { error: "bad_request" });
    }

    if (path === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return sendAndClose(req, res, 405, { error: "method_not_allowed" });
      return sendAndClose(req, res, 200, { ok: true, tenant, version: VERSION });
    }

    const isExec = path === "/" || path === "/exec";
    const isPipeline = path === "/pipeline";
    if (!isExec && !isPipeline) return sendAndClose(req, res, 404, { error: "not_found" });
    if (req.method !== "POST") return sendAndClose(req, res, 405, { error: "method_not_allowed" });

    if (inFlight >= L.maxInFlight) return sendAndDestroy(req, res, 503, { error: "busy" });
    inFlight++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight--;
      }
    };
    res.once("close", release);
    res.once("finish", release);

    if (!tokenMatches(bearer(req), expected)) {
      emit("auth", null, false, t0);
      const src = req.socket?.remoteAddress || "?";
      if (!authFails.take(src)) return sendAndDestroy(req, res, 429, { error: "rate_limited" });
      return sendAndClose(req, res, 401, { error: "unauthorized" });
    }

    let raw;
    try {
      raw = await readBody(req, L.maxBodyBytes);
    } catch {
      return sendAndClose(req, res, 400, { error: "bad_request" });
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
      let cmds;
      if (isPipeline) {
        if (!Array.isArray(body) || body.length === 0 || !body.every(Array.isArray)) return send(res, 400, { error: "bad_request" });
        if (body.length > L.maxPipeline) {
          emit("pipeline", null, false, t0);
          return send(res, 413, { error: "pipeline_too_large" });
        }
        cmds = body;
      } else {
        cmds = [body];
      }
      const [status, out] = await runRequest(cmds, isPipeline, t0);
      return send(res, status, out);
    } catch {
      return send(res, 500, { error: "internal_error" });
    }
  }

  return {
    handler,
    limits: L,
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
