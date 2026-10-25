// Native Redis (TCP) command runner for self-hosted backends.
// Accepts Upstash-REST-style commands (["ZADD", key, score, member]) and
// returns Upstash-REST-shaped replies (flat arrays for WITHSCORES/HGETALL)
// so callers can't tell which backend they're on.
//
// Clients are cached per-URI across warm invocations; a failed client is
// evicted so the next call reconnects. Every command is bounded by
// LOGMEM_REDIS_TIMEOUT_MS (default 5000); a timeout evicts the client only if
// its socket looks dead (see evictIfDead).

import { createClient } from "redis";
import { pinnedNativeOptions } from "../http/pin.mjs";

const CONNECT_TIMEOUT_MS = 4000;
const DEFAULT_TIMEOUT_MS = 5000;

/** Same budget as the REST client: LOGMEM_REDIS_TIMEOUT_MS, default 5000. */
export function nativeTimeoutMs(env = process.env) {
  const n = Number(env?.LOGMEM_REDIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Race a promise against a timer. On timeout, rejects with an error naming
 * `label` (the command) and runs `onTimeout` (used to evict a dead client).
 * The timer is always cleared so it never holds the event loop open.
 */
export function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best effort */ }
      reject(new Error(`native redis ${label}: timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function clientCache() {
  if (!globalThis.__acmiNativeClients) globalThis.__acmiNativeClients = new Map();
  return globalThis.__acmiNativeClients;
}

/**
 * Return a connected client for `uri`. `used`, when given, records which
 * cache entry (`used.pending`) and client (`used.client`) this call ended up
 * on, so a timeout can tell whether it is still looking at the same client.
 */
async function getNativeClient(uri, used = {}) {
  const cache = clientCache();
  const existing = cache.get(uri);
  if (existing) {
    used.pending = existing;
    try {
      const client = await existing;
      if (client.isOpen) {
        used.client = client;
        return client;
      }
    } catch {
      // fall through to reconnect
    }
    if (cache.get(uri) === existing) cache.delete(uri);
  }
  const pending = (async () => {
    const client = createClient({
      url: uri,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    client.on("error", () => {
      // Only drop our own entry; a newer client may already be cached.
      if (cache.get(uri) === pending) cache.delete(uri);
    });
    await client.connect();
    return client;
  })();
  cache.set(uri, pending);
  used.pending = pending;
  used.client = undefined;
  try {
    const client = await pending;
    used.client = client;
    return client;
  } catch (e) {
    if (cache.get(uri) === pending) cache.delete(uri);
    throw new Error(`native redis connect failed: ${e.message}`);
  }
}

/**
 * Called when a command times out. Evicts the cached client only when
 *   - the cache still holds the exact entry this call used (never a newer one), and
 *   - the client shows socket-level failure: connect never finished, or it is
 *     no longer open/ready.
 * A merely slow command on a healthy socket leaves the shared client alone, so
 * other in-flight commands on it are not cut off.
 * Returns true when it evicted.
 */
export function evictIfDead(uri, used, cache = clientCache()) {
  if (!used?.pending || cache.get(uri) !== used.pending) return false;
  const c = used.client;
  const dead = !c || c.isOpen === false || c.isReady === false;
  if (!dead) return false;
  cache.delete(uri);
  if (c) Promise.resolve().then(() => c.disconnect?.()).catch(() => {});
  else Promise.resolve(used.pending).then((late) => late?.disconnect?.()).catch(() => {});
  return true;
}

function flattenWithScores(items) {
  const flat = [];
  for (const item of items) flat.push(item.value, String(item.score));
  return flat;
}

function kvPairs(args, start) {
  // Null prototype: a field named __proto__ is data, not a prototype setter.
  const obj = Object.create(null);
  for (let i = start; i < args.length; i += 2) obj[args[i]] = args[i + 1];
  return obj;
}

// Sent verbatim: the reply shape already matches Upstash REST. EVAL/EVALSHA serve
// the ACMI Cloud control plane (atomic tenant create, quota reserve).
const PASSTHROUGH = new Set(["INCRBY", "DECRBY", "HSETNX", "SISMEMBER", "EVAL", "EVALSHA"]);
// Also sent verbatim: every other command the acmi-bridge jail allows
// (cloud/bridge/bridge.mjs COMMANDS) that the switch below does not translate,
// so a redis:// upstream runs the whole bridge table.
export const VERBATIM = new Set([
  "UNLINK", "TOUCH", "PTTL", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST", "RENAME", "RENAMENX", "COPY",
  "GETRANGE", "STRLEN", "MGET", "SETNX", "SETEX", "PSETEX", "SETRANGE", "GETSET", "GETDEL", "GETEX", "APPEND",
  "INCRBYFLOAT", "MSET", "MSETNX",
  "HMGET", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSTRLEN", "HSCAN", "HMSET", "HINCRBY", "HINCRBYFLOAT",
  "LLEN", "LINDEX", "LPOS", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "RPOPLPUSH", "LMOVE",
  "SMISMEMBER", "SCARD", "SRANDMEMBER", "SSCAN", "SINTER", "SUNION", "SDIFF", "SPOP", "SMOVE",
  "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE",
  "ZRANGEBYLEX", "ZREVRANGEBYLEX", "ZMSCORE", "ZRANK", "ZREVRANK", "ZCOUNT", "ZLEXCOUNT", "ZRANDMEMBER", "ZSCAN",
  "ZUNION", "ZINTER", "ZDIFF", "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK",
  "ZREMRANGEBYLEX", "ZUNIONSTORE", "ZINTERSTORE", "ZDIFFSTORE", "ZRANGESTORE",
  "XADD", "XDEL", "XTRIM", "XLEN", "XRANGE", "XREVRANGE",
]);
const ZADD_FLAGS = new Set(["NX", "XX", "LT", "GT", "CH"]);

export async function translate(client, command, args) {
  const upper = String(command).toUpperCase();
  if (PASSTHROUGH.has(upper) || VERBATIM.has(upper)) return await client.sendCommand([upper, ...args.map(String)]);
  switch (upper) {
    case "PING": return await client.ping();
    case "GET": return await client.get(args[0]);
    // Options (NX, EX, ...) must reach Redis: SET NX is how a decision is set once.
    case "SET": return args.length > 2 ? await client.sendCommand(["SET", ...args.map(String)]) : await client.set(args[0], args[1]);
    case "DEL": return await client.del(args);
    case "EXISTS": return await client.exists(args);
    case "TYPE": return await client.type(args[0]);
    case "KEYS": return await client.keys(args[0]);
    case "SCAN": {
      const matchIdx = args.indexOf("MATCH");
      const countIdx = args.indexOf("COUNT");
      const typeIdx = args.indexOf("TYPE");
      return await client.sendCommand([
        "SCAN", String(args[0] ?? "0"),
        "MATCH", matchIdx >= 0 ? args[matchIdx + 1] : "*",
        "COUNT", String(countIdx >= 0 ? args[countIdx + 1] : 100),
        ...(typeIdx >= 0 ? ["TYPE", String(args[typeIdx + 1])] : []),
      ]);
    }
    case "TTL": return await client.ttl(args[0]);
    case "EXPIRE": return await client.expire(args[0], parseInt(args[1]));
    case "HGET": return await client.hGet(args[0], args[1]);
    case "HSET":
      if (args.length === 3) return await client.hSet(args[0], args[1], args[2]);
      return await client.hSet(args[0], kvPairs(args, 1));
    case "HDEL": return await client.hDel(args[0], args.slice(1));
    case "HGETALL": {
      const obj = await client.hGetAll(args[0]);
      const flat = [];
      for (const [k, v] of Object.entries(obj)) flat.push(k, v);
      return flat;
    }
    case "SADD": return await client.sAdd(args[0], args.slice(1));
    case "SREM": return await client.sRem(args[0], args.slice(1));
    case "SMEMBERS": return await client.sMembers(args[0]);
    case "LPUSH": return await client.lPush(args[0], args.slice(1));
    case "RPUSH": return await client.rPush(args[0], args.slice(1));
    case "LRANGE": return await client.lRange(args[0], parseInt(args[1]), parseInt(args[2]));
    case "ZADD": {
      // Flags (LT = write-if-lower for rotate grace) must reach Redis untouched.
      if (ZADD_FLAGS.has(String(args[1]).toUpperCase())) return await client.sendCommand(["ZADD", ...args.map(String)]);
      const members = [];
      for (let i = 1; i < args.length; i += 2) {
        members.push({ score: parseFloat(args[i]), value: String(args[i + 1]) });
      }
      return await client.zAdd(args[0], members);
    }
    case "ZREM": return await client.zRem(args[0], args.slice(1));
    case "ZCARD": return await client.zCard(args[0]);
    case "ZSCORE": return await client.zScore(args[0], args[1]);
    case "ZRANGE":
    case "ZREVRANGE": {
      // Options past a lone WITHSCORES (BYSCORE, BYLEX, REV, LIMIT): send verbatim.
      if (args.length > 4 || (args.length === 4 && String(args[3]).toUpperCase() !== "WITHSCORES")) {
        return await client.sendCommand([upper, ...args.map(String)]);
      }
      const rev = String(command).toUpperCase() === "ZREVRANGE";
      const withScores = args[3]?.toUpperCase?.() === "WITHSCORES";
      const opts = rev ? { REV: true } : undefined;
      if (withScores) {
        const items = await client.zRangeWithScores(args[0], parseInt(args[1]), parseInt(args[2]), opts);
        return flattenWithScores(items);
      }
      return await client.zRange(args[0], parseInt(args[1]), parseInt(args[2]), opts);
    }
    case "ZRANGEBYSCORE":
    case "ZREVRANGEBYSCORE": {
      const rev = String(command).toUpperCase() === "ZREVRANGEBYSCORE";
      // Upstash arg order: key min max (rev: key max min)
      const min = rev ? args[2] : args[1];
      const max = rev ? args[1] : args[2];
      const rest = args.slice(3).map((a) => String(a).toUpperCase());
      const withScores = rest.includes("WITHSCORES");
      const limitIdx = rest.indexOf("LIMIT");
      const opts = {};
      if (limitIdx >= 0) {
        opts.LIMIT = { offset: parseInt(args[3 + limitIdx + 1]), count: parseInt(args[3 + limitIdx + 2]) };
      }
      if (withScores) {
        const items = await client.zRangeByScoreWithScores(args[0], min, max, opts);
        if (rev) items.reverse();
        return flattenWithScores(items);
      }
      const items = await client.zRangeByScore(args[0], min, max, opts);
      if (rev) items.reverse();
      return items;
    }
    case "INCR": return await client.incr(args[0]);
    case "DECR": return await client.decr(args[0]);
    case "DBSIZE": return await client.dbSize();
    default:
      throw new Error(`native redis: unsupported command ${command}`);
  }
}

/**
 * One-shot rediss:// client dialed at the pinned address. Not cached: the
 * URI's password must not sit in the warm-instance client map. Reconnect is
 * off so a drop cannot resolve the name a second time. CLIENT SETINFO is
 * off so this read-only probe does not write the user's Redis.
 */
export async function createPinnedRunner(uri, pin) {
  let client;
  try {
    client = createClient(pinnedNativeOptions(uri, pin));
    client.on("error", () => {});
    await client.connect();
  } catch {
    try { await client?.disconnect?.(); } catch { /* already gone */ }
    throw new Error("native redis connect failed");
  }
  const run = async (...cmd) => {
    const [command, ...args] = cmd;
    return translate(client, command, args.map((a) => (typeof a === "number" ? String(a) : a)));
  };
  run.close = async () => {
    try { await client.disconnect(); } catch { /* already gone */ }
  };
  return run;
}

export async function nativeRedisCall(uri, ...cmd) {
  const [command, ...args] = cmd;
  const name = String(command ?? "?").toUpperCase();
  const used = {};
  const run = async () => {
    const client = await getNativeClient(uri, used);
    return await translate(client, command, args.map((a) => (typeof a === "number" ? String(a) : a)));
  };
  return withTimeout(run(), nativeTimeoutMs(), name, () => evictIfDead(uri, used));
}

export async function probeNativeRedis(uri) {
  const result = await nativeRedisCall(uri, "PING");
  if (result !== "PONG") throw new Error(`PING returned ${result}`);
  return true;
}
