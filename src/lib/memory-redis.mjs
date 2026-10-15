// memory-redis.mjs — in-process Redis emulator with the same call shape as the
// REST/native runners: `await redis("ZADD", key, score, member)`.
//
// Used for tests, the ACMI conformance adapter, and stdio degraded mode (no
// backend reachable). Replies mirror Upstash REST: flat arrays for WITHSCORES
// and HGETALL, integers for counts, null for missing.
//
// Only the commands LogMem uses are implemented. Anything else throws, so a
// new call site fails loudly in tests instead of silently doing nothing.

// EVAL runs scripts registered in lua-scripts.mjs (the ACMI cloud control plane).
// The body runs synchronously against this process's map, which is the atomicity
// the tests rely on. A real Redis runs the same script text via EVAL.
import { evalScriptFor } from "./lua-scripts.mjs";

// Kept for existing importers; the registry itself lives in lua-scripts.mjs.
export { registerEvalScript } from "./lua-scripts.mjs";

function globToRegex(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function scoreBound(v, isMin) {
  const s = String(v);
  if (s === "-inf") return { n: -Infinity, excl: false };
  if (s === "+inf" || s === "inf") return { n: Infinity, excl: false };
  if (s.startsWith("(")) return { n: Number(s.slice(1)), excl: true };
  return { n: Number(s), excl: false, isMin };
}

export function createMemoryRedis() {
  const data = new Map(); // key -> { type, value }

  const get = (key, type) => {
    const e = data.get(key);
    if (!e) return null;
    if (type && e.type !== type) {
      throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
    }
    return e;
  };

  const zsorted = (e) =>
    [...e.value.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0));

  const flat = (items, withScores) =>
    withScores ? items.flatMap((i) => [i.member, String(i.score)]) : items.map((i) => i.member);

  const sliceRange = (items, start, stop) => {
    const len = items.length;
    let s = Number(start);
    let t = Number(stop);
    if (s < 0) s = Math.max(len + s, 0);
    if (t < 0) t = len + t;
    if (t >= len) t = len - 1;
    if (s > t) return [];
    return items.slice(s, t + 1);
  };

  const commands = {
    PING: () => "PONG",
    GET: (k) => {
      const e = get(k, "string");
      return e ? e.value : null;
    },
    SET: (k, v, ...opts) => {
      const flags = opts.map((o) => String(o).toUpperCase());
      if (flags.includes("NX") && data.has(k)) return null;
      if (flags.includes("XX") && !data.has(k)) return null;
      data.set(k, { type: "string", value: String(v) });
      return "OK";
    },
    DEL: (...keys) => keys.reduce((n, k) => n + (data.delete(k) ? 1 : 0), 0),
    EXISTS: (...keys) => keys.reduce((n, k) => n + (data.has(k) ? 1 : 0), 0),
    TYPE: (k) => (data.get(k)?.type ?? "none"),
    KEYS: (pattern) => {
      const re = globToRegex(pattern);
      return [...data.keys()].filter((k) => re.test(k)).sort();
    },
    INCR: (k) => {
      const e = get(k, "string");
      const n = (e ? Number(e.value) : 0) + 1;
      if (!Number.isInteger(n)) throw new Error("ERR value is not an integer or out of range");
      data.set(k, { type: "string", value: String(n) });
      return n;
    },
    INCRBY: (k, by) => {
      const e = get(k, "string");
      const n = (e ? Number(e.value) : 0) + Number(by);
      if (!Number.isSafeInteger(n) || !Number.isInteger(Number(by))) {
        throw new Error("ERR value is not an integer or out of range");
      }
      data.set(k, { type: "string", value: String(n) });
      return n;
    },
    EXPIRE: (k) => (data.has(k) ? 1 : 0),
    TTL: (k) => (data.has(k) ? -1 : -2),
    DBSIZE: () => data.size,
    // Single-pass SCAN: returns everything matching with cursor "0".
    SCAN: (_cursor, ...opts) => {
      const i = opts.findIndex((o) => String(o).toUpperCase() === "MATCH");
      const re = globToRegex(i >= 0 ? opts[i + 1] : "*");
      return ["0", [...data.keys()].filter((k) => re.test(k)).sort()];
    },
    SADD: (k, ...members) => {
      let e = get(k, "set");
      if (!e) {
        e = { type: "set", value: new Set() };
        data.set(k, e);
      }
      let added = 0;
      for (const m of members) {
        if (!e.value.has(String(m))) {
          e.value.add(String(m));
          added++;
        }
      }
      return added;
    },
    SREM: (k, ...members) => {
      const e = get(k, "set");
      if (!e) return 0;
      let n = 0;
      for (const m of members) if (e.value.delete(String(m))) n++;
      if (!e.value.size) data.delete(k);
      return n;
    },
    SMEMBERS: (k) => {
      const e = get(k, "set");
      return e ? [...e.value].sort() : [];
    },
    SISMEMBER: (k, m) => (get(k, "set")?.value.has(String(m)) ? 1 : 0),
    HSET: (k, ...pairs) => {
      let e = get(k, "hash");
      if (!e) {
        e = { type: "hash", value: new Map() };
        data.set(k, e);
      }
      let added = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        if (!e.value.has(String(pairs[i]))) added++;
        e.value.set(String(pairs[i]), String(pairs[i + 1]));
      }
      return added;
    },
    HSETNX: (k, f, v) => {
      let e = get(k, "hash");
      if (e?.value.has(String(f))) return 0;
      if (!e) {
        e = { type: "hash", value: new Map() };
        data.set(k, e);
      }
      e.value.set(String(f), String(v));
      return 1;
    },
    HGET: (k, f) => get(k, "hash")?.value.get(String(f)) ?? null,
    HDEL: (k, ...fields) => {
      const e = get(k, "hash");
      if (!e) return 0;
      let n = 0;
      for (const f of fields) if (e.value.delete(String(f))) n++;
      if (!e.value.size) data.delete(k);
      return n;
    },
    HGETALL: (k) => {
      const e = get(k, "hash");
      return e ? [...e.value.entries()].flat() : [];
    },
    LRANGE: (k, start, stop) => {
      const e = get(k, "list");
      return e ? sliceRange(e.value, start, stop) : [];
    },
    RPUSH: (k, ...vals) => {
      let e = get(k, "list");
      if (!e) {
        e = { type: "list", value: [] };
        data.set(k, e);
      }
      e.value.push(...vals.map(String));
      return e.value.length;
    },
    ZADD: (k, ...rest) => {
      // Leading flags: NX | XX | LT | GT (Redis 6.2+). LT/GT = write-if-lower/higher.
      const flags = new Set();
      while (rest.length && ["NX", "XX", "LT", "GT"].includes(String(rest[0]).toUpperCase())) {
        flags.add(String(rest.shift()).toUpperCase());
      }
      const args = rest;
      let e = get(k, "zset");
      if (!e) {
        e = { type: "zset", value: new Map() };
        data.set(k, e);
      }
      let added = 0;
      for (let i = 0; i < args.length; i += 2) {
        const member = String(args[i + 1]);
        const score = Number(args[i]);
        const has = e.value.has(member);
        if ((flags.has("NX") && has) || (flags.has("XX") && !has)) continue;
        if (has && flags.has("LT") && !(score < e.value.get(member))) continue;
        if (has && flags.has("GT") && !(score > e.value.get(member))) continue;
        if (!has) added++;
        e.value.set(member, score);
      }
      if (!e.value.size) data.delete(k);
      return added;
    },
    ZREM: (k, ...members) => {
      const e = get(k, "zset");
      if (!e) return 0;
      let n = 0;
      for (const m of members) if (e.value.delete(String(m))) n++;
      if (!e.value.size) data.delete(k);
      return n;
    },
    // Streams: only XADD with an auto id ("*"), XLEN, and a full XRANGE - +.
    // Ids are <ms>-<seq> and only grow, like a real Redis stream.
    XADD: (k, id, ...pairs) => {
      if (id !== "*") throw new Error('memory-redis: XADD supports only "*" ids');
      if (!pairs.length || pairs.length % 2) throw new Error("ERR wrong number of arguments for 'xadd' command");
      let e = get(k, "stream");
      if (!e) {
        e = { type: "stream", value: [], last: [0, -1] };
        data.set(k, e);
      }
      const ms = Math.max(Date.now(), e.last[0]);
      const seq = ms === e.last[0] ? e.last[1] + 1 : 0;
      e.last = [ms, seq];
      const entryId = `${ms}-${seq}`;
      e.value.push([entryId, pairs.map(String)]);
      return entryId;
    },
    XLEN: (k) => get(k, "stream")?.value.length ?? 0,
    XRANGE: (k, start, end) => {
      if (start !== "-" || end !== "+") throw new Error("memory-redis: XRANGE supports only - +");
      const e = get(k, "stream");
      return e ? e.value.map(([id, f]) => [id, [...f]]) : [];
    },
    ZCARD: (k) => get(k, "zset")?.value.size ?? 0,
    ZRANGE: (k, start, stop, ...opts) => {
      const e = get(k, "zset");
      if (!e) return [];
      const withScores = opts.some((o) => String(o).toUpperCase() === "WITHSCORES");
      return flat(sliceRange(zsorted(e), start, stop), withScores);
    },
    ZREVRANGE: (k, start, stop, ...opts) => {
      const e = get(k, "zset");
      if (!e) return [];
      const withScores = opts.some((o) => String(o).toUpperCase() === "WITHSCORES");
      return flat(sliceRange(zsorted(e).reverse(), start, stop), withScores);
    },
    EVAL: (script, numkeys, ...rest) => {
      const fn = evalScriptFor(script);
      if (!fn) throw new Error("memory-redis: unsupported EVAL script");
      const n = Number(numkeys);
      if (!Number.isInteger(n) || n < 0 || n > rest.length) throw new Error("ERR wrong number of keys");
      const call = (cmd, ...a) => commands[String(cmd).toUpperCase()](...a.map((x) => (typeof x === "number" ? x : String(x))));
      return fn(call, rest.slice(0, n), rest.slice(n));
    },
    ZRANGEBYSCORE: (k, min, max, ...opts) => {
      const e = get(k, "zset");
      if (!e) return [];
      const lo = scoreBound(min, true);
      const hi = scoreBound(max, false);
      const withScores = opts.some((o) => String(o).toUpperCase() === "WITHSCORES");
      const items = zsorted(e).filter(
        (i) =>
          (lo.excl ? i.score > lo.n : i.score >= lo.n) &&
          (hi.excl ? i.score < hi.n : i.score <= hi.n),
      );
      return flat(items, withScores);
    },
  };

  async function redis(cmd, ...args) {
    const fn = commands[String(cmd).toUpperCase()];
    if (!fn) throw new Error(`memory-redis: unsupported command ${cmd}`);
    return fn(...args.map((a) => (typeof a === "number" ? a : String(a))));
  }
  redis.kind = "memory";
  redis._data = data;
  return redis;
}
