// Native Redis (TCP) command runner for self-hosted backends.
// Accepts Upstash-REST-style commands (["ZADD", key, score, member]) and
// returns Upstash-REST-shaped replies (flat arrays for WITHSCORES/HGETALL)
// so callers can't tell which backend they're on.
//
// Clients are cached per-URI across warm invocations; a failed client is
// evicted so the next call reconnects.

import { createClient } from "redis";

const CONNECT_TIMEOUT_MS = 4000;

function clientCache() {
  if (!globalThis.__acmiNativeClients) globalThis.__acmiNativeClients = new Map();
  return globalThis.__acmiNativeClients;
}

async function getNativeClient(uri) {
  const cache = clientCache();
  const existing = cache.get(uri);
  if (existing) {
    try {
      const client = await existing;
      if (client.isOpen) return client;
    } catch {
      // fall through to reconnect
    }
    cache.delete(uri);
  }
  const pending = (async () => {
    const client = createClient({
      url: uri,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    client.on("error", () => {
      cache.delete(uri);
    });
    await client.connect();
    return client;
  })();
  cache.set(uri, pending);
  try {
    return await pending;
  } catch (e) {
    cache.delete(uri);
    throw new Error(`native redis connect failed: ${e.message}`);
  }
}

function flattenWithScores(items) {
  const flat = [];
  for (const item of items) flat.push(item.value, String(item.score));
  return flat;
}

function kvPairs(args, start) {
  const obj = {};
  for (let i = start; i < args.length; i += 2) obj[args[i]] = args[i + 1];
  return obj;
}

async function translate(client, command, args) {
  switch (String(command).toUpperCase()) {
    case "PING": return await client.ping();
    case "GET": return await client.get(args[0]);
    case "SET": return await client.set(args[0], args[1]);
    case "DEL": return await client.del(args);
    case "EXISTS": return await client.exists(args[0]);
    case "TYPE": return await client.type(args[0]);
    case "KEYS": return await client.keys(args[0]);
    case "SCAN": {
      const matchIdx = args.indexOf("MATCH");
      const countIdx = args.indexOf("COUNT");
      return await client.sendCommand([
        "SCAN", String(args[0] ?? "0"),
        "MATCH", matchIdx >= 0 ? args[matchIdx + 1] : "*",
        "COUNT", String(countIdx >= 0 ? args[countIdx + 1] : 100),
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

export function isRedisUri(s) {
  return /^rediss?:\/\//i.test(String(s || ""));
}

export async function nativeRedisCall(uri, ...cmd) {
  const client = await getNativeClient(uri);
  const [command, ...args] = cmd;
  return await translate(client, command, args.map((a) => (typeof a === "number" ? String(a) : a)));
}

export async function probeNativeRedis(uri) {
  const result = await nativeRedisCall(uri, "PING");
  if (result !== "PONG") throw new Error(`PING returned ${result}`);
  return true;
}
