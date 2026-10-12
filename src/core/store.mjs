// store.mjs — LogMem storage over a Redis command runner, bound to one space.
//
// Every write goes to lm:{space}:*. With `compat: true` every read also pulls
// the matching legacy acmi:{space}:* key and translates it (fields, kinds,
// timestamp units) so agents see one merged history during cutover.
//
// Timestamps: always milliseconds on write. On read, scores and `ts` fields
// in seconds / microseconds / nanoseconds are normalised to ms (normTs).

import { lmKey, lmIndexKey, acmiKey, acmiIndexKey, PROTECTED } from "./keys.mjs";
import { asEntry, normalizeKind } from "./vocab.mjs";
import { isProtectedKey } from "../lib/helpers.mjs";

export function normTs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x > 1e17) return Math.floor(x / 1e6); // ns -> ms
  if (x > 1e14) return Math.floor(x / 1e3); // us -> ms
  // Seconds only when the value is a plausible epoch-seconds reading
  // (2001..5138). Smaller numbers are left alone: fixtures and relative
  // clocks use them, and scaling would reorder nothing but break equality.
  if (x >= 1e9 && x < 1e11) return Math.floor(x * 1e3); // s -> ms
  return Math.floor(x);
}

export function tryParse(s) {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Stable stringify so identical entries dedupe in the ZSET (sorted keys). */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function parseZ(arr) {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += 2) {
    out.push({ score: normTs(arr[i + 1]), member: arr[i] });
  }
  return out;
}

function parseHash(arr) {
  const out = {};
  for (let i = 0; i < (arr || []).length; i += 2) out[arr[i]] = tryParse(arr[i + 1]);
  return out;
}

const typeOf = async (redis, key) => String((await redis("TYPE", key)) || "none").toLowerCase();

/** Read an object slot that may be a HASH (LogMem) or a JSON STRING (legacy). */
async function readObject(redis, key) {
  const t = await typeOf(redis, key);
  if (t === "hash") return parseHash(await redis("HGETALL", key));
  if (t === "string") {
    const v = tryParse(await redis("GET", key));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  return {};
}

async function readIds(redis, key) {
  const t = await typeOf(redis, key);
  if (t === "set") return redis("SMEMBERS", key);
  if (t === "list") return redis("LRANGE", key, 0, -1);
  if (t === "hash") return Object.keys(parseHash(await redis("HGETALL", key)));
  if (t === "string") {
    const v = tryParse(await redis("GET", key));
    if (Array.isArray(v)) return v.map(String);
    if (v && typeof v === "object") return (v.ids || v.work_ids || []).map(String);
  }
  return [];
}

export function createStore(redis, { space, compat = false, mirror = null } = {}) {
  if (!space) throw new Error("createStore: space required");
  const k = (ns, id, slot) => lmKey(space, ns, id, slot);
  const legacy = (ns, id, slot) => acmiKey(space, ns, id, slot);

  async function index(ns, id) {
    await redis("SADD", lmIndexKey(space, ns), id);
  }

  /** Dogfood mirror: write the ACMI twin; record ok/failed for the caller. */
  async function mirrorWrite(op) {
    if (!mirror) return;
    store.mirrorEvents.push(await mirror.write(op));
  }

  const store = {
    space,
    compat,
    redis,
    key: k,
    mirror,
    /** "ok" | "failed" per mirrored write since the last reset (server resets per tool call). */
    mirrorEvents: [],

    // ─── Who ────────────────────────────────────────────────────────────
    async getWho(ns, id) {
      let v = tryParse(await redis("GET", k(ns, id, "who")));
      if (v == null && compat) v = tryParse(await redis("GET", legacy(ns, id, "who")));
      return v ?? null;
    },
    async setWho(ns, id, doc) {
      await redis("SET", k(ns, id, "who"), JSON.stringify(doc));
      await index(ns, id);
      await mirrorWrite({ slot: "who", ns, id, doc });
      return doc;
    },
    async mergeWho(ns, id, partial) {
      const cur = (await store.getWho(ns, id)) || {};
      return store.setWho(ns, id, { ...cur, ...partial });
    },
    async deleteWho(ns, id) {
      await redis("DEL", k(ns, id, "who"));
    },

    // ─── Now ────────────────────────────────────────────────────────────
    async getNow(ns, id) {
      const own = await readObject(redis, k(ns, id, "now"));
      if (!compat) return own;
      const old = await readObject(redis, legacy(ns, id, "now"));
      return { ...old, ...own };
    },
    async setNow(ns, id, fields) {
      const pairs = Object.entries(fields).flatMap(([f, v]) => [f, JSON.stringify(v)]);
      if (pairs.length) await redis("HSET", k(ns, id, "now"), ...pairs);
      await index(ns, id);
      await mirrorWrite({ slot: "now", ns, id, fields });
      return store.getNow(ns, id);
    },
    /** ACMI semantics: signals are replaced wholesale, not merged. */
    async replaceNow(ns, id, fields) {
      await redis("DEL", k(ns, id, "now"));
      return store.setNow(ns, id, fields);
    },
    async deleteNow(ns, id, field) {
      await redis("HDEL", k(ns, id, "now"), field);
    },

    // ─── Log ────────────────────────────────────────────────────────────
    /**
     * Append one entry. `ts` defaults to now (ms); an explicit ts is
     * normalised to ms. Exact duplicates collapse (same ZSET member).
     */
    async append(ns, id, entry) {
      if (!entry || typeof entry !== "object") throw new Error("entry must be an object");
      const ts = entry.ts == null ? Date.now() : normTs(entry.ts);
      const full = { ...entry, ...normalizeKind(entry.kind), ts };
      if (entry.acmi_kind) full.acmi_kind = entry.acmi_kind;
      delete full._o;
      const key = k(ns, id, "log");
      // A ZSET orders same-score members by their bytes, not by arrival.
      // Members lead with `_o` (ordinal within this ms) so ties keep append
      // order; exact duplicates (same content, same ts) still collapse.
      const body = stableJson(full);
      const same = await redis("ZRANGEBYSCORE", key, ts, ts);
      for (const m of same || []) {
        const parsed = tryParse(m);
        if (parsed && typeof parsed === "object") {
          const { _o, ...rest } = parsed;
          if (stableJson(rest) === body) return full;
        }
      }
      const ordinal = String((same || []).length).padStart(6, "0");
      await redis("ZADD", key, ts, stableJson({ _o: ordinal, ...full }));
      await index(ns, id);
      await mirrorWrite({ slot: "log", ns, id, entry: full });
      return full;
    },
    async readLog(ns, id, { limit, reverse = false, sinceMs, untilMs } = {}) {
      const min = sinceMs != null ? normTs(sinceMs) : "-inf";
      const max = untilMs != null ? normTs(untilMs) : "+inf";
      const rows = parseZ(await redis("ZRANGEBYSCORE", k(ns, id, "log"), min, max, "WITHSCORES"));
      if (compat) {
        // Legacy scores may be in s/us/ns, so scan the whole key and filter
        // after normalising (a score-range query would miss mixed units).
        const old = parseZ(await redis("ZRANGE", legacy(ns, id, "log"), 0, -1, "WITHSCORES"));
        // After the migration copy, an entry exists in both places. The lm
        // copy wins; the legacy twin (same ts + trail + summary) is skipped.
        const sig = (e) => `${normTs(e.ts)}|${e.trail ?? ""}|${e.summary ?? ""}`;
        const have = new Set(rows.map((r) => sig(asEntry(tryParse(r.member)) || {})));
        for (const r of old) {
          if ((sinceMs == null || r.score >= min) && (untilMs == null || r.score <= max)) {
            const e = asEntry(tryParse(r.member));
            if (e && typeof e === "object" && have.has(sig({ ...e, ts: e.ts ?? r.score }))) continue;
            rows.push({ ...r, legacy: true });
          }
        }
      }
      let entries = rows.map((r, i) => {
        const e = asEntry(tryParse(r.member));
        const { _o, ...obj } = e && typeof e === "object" ? e : { summary: String(e) };
        const out = { ...obj, ts: normTs(obj.ts ?? r.score) };
        // Rows merged from legacy acmi:* keys carry a non-enumerable flag, so
        // readers can refuse to treat them as asks or decisions without
        // changing what compat reads return.
        if (r.legacy) Object.defineProperty(out, "legacy", { value: true, enumerable: false });
        return { e: out, o: _o ?? "", i };
      });
      // Stable: ts, then same-ms ordinal, then read order.
      entries.sort((a, b) => a.e.ts - b.e.ts || (a.o < b.o ? -1 : a.o > b.o ? 1 : a.i - b.i));
      entries = entries.map((x) => x.e);
      if (reverse) entries.reverse();
      if (limit != null) entries = entries.slice(0, limit);
      return entries;
    },
    async logSize(ns, id) {
      let n = Number(await redis("ZCARD", k(ns, id, "log"))) || 0;
      if (compat) n += Number(await redis("ZCARD", legacy(ns, id, "log"))) || 0;
      return n;
    },

    // ─── Roster ─────────────────────────────────────────────────────────
    async list(ns) {
      const ids = new Set(await readIds(redis, lmIndexKey(space, ns)));
      if (compat) for (const id of await readIds(redis, acmiIndexKey(space, ns))) ids.add(id);
      return [...ids].map(String).filter(Boolean).sort();
    },

    // ─── Agent-only slots ───────────────────────────────────────────────
    async getRecap(agent) {
      let v = tryParse(await redis("GET", k("agent", agent, "recap")));
      if (v == null && compat) v = tryParse(await redis("GET", legacy("agent", agent, "recap")));
      return v ?? null;
    },
    async setRecap(agent, recap) {
      await redis("SET", k("agent", agent, "recap"), JSON.stringify(recap));
      await index("agent", agent);
    },
    async follows(agent) {
      const own = await readObject(redis, k("agent", agent, "follows"));
      if (!compat) return own;
      return { ...(await readObject(redis, legacy("agent", agent, "follows"))), ...own };
    },
    async follow(agent, ref, value) {
      await redis("HSET", k("agent", agent, "follows"), ref, JSON.stringify(value));
    },
    async unfollow(agent, ref) {
      await redis("HDEL", k("agent", agent, "follows"), ref);
    },
    async addShift(agent, shift) {
      await redis("ZADD", k("agent", agent, "shifts"), shift.ts, stableJson(shift));
    },
    async recentShifts(agent, n = 5) {
      const rows = parseZ(await redis("ZREVRANGE", k("agent", agent, "shifts"), 0, n - 1, "WITHSCORES"));
      return rows.map((r) => ({ ...tryParse(r.member), ts: r.score }));
    },

    // ─── Job-only slots ─────────────────────────────────────────────────
    async addJobSession(job, sessionId) {
      await redis("SADD", k("job", job, "sessions"), sessionId);
    },
    async jobSessions(job) {
      return redis("SMEMBERS", k("job", job, "sessions"));
    },

    // ─── Remove ─────────────────────────────────────────────────────────
    /** Dry-run unless confirm. Only keys inside this space; never protected. */
    async remove(key, { confirm = false } = {}) {
      const own = `lm:${space}:`;
      if (!String(key).startsWith(own)) {
        throw new Error(`refused: key must start with '${own}' (this space only)`);
      }
      if (PROTECTED.some((re) => re.test(key)) || isProtectedKey(key.replace(/^lm:[^:]+:/, "acmi:"))) {
        throw new Error(`refused: ${key} is protected and is never removed`);
      }
      const exists = Number(await redis("EXISTS", key)) === 1;
      const type = exists ? await typeOf(redis, key) : null;
      if (!confirm) return { dry_run: true, key, exists, type, hint: "pass confirm=true to remove" };
      if (!exists) return { dry_run: false, key, removed: false, reason: "key did not exist" };
      const n = Number(await redis("DEL", key));
      return { dry_run: false, key, removed: n === 1, type };
    },
  };
  return store;
}
