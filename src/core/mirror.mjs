// mirror.mjs — dogfood write-mirror: every lm:{space}:* write also lands in
// acmi:{space}:* in ACMI shape, so agents still on ACMI miss nothing.
//
// On only when LOGMEM_MIRROR_ACMI=1 and the space is listed in
// LOGMEM_MIRROR_SPACES (default "madez"). Slots mirrored: log, now, who.
// A failed twin goes to lm:{space}:mirror:retry (ZSET, score = ms) and is
// retried at the start of the next write. The daily check counts anything
// still unmirrored as a mismatch.

import { acmiKey, acmiIndexKey } from "./keys.mjs";
import { entryToAcmi } from "./vocab.mjs";
import { tryParse } from "./store.mjs";

export const MIRROR_MARK = "lm";

export function mirrorConfigFromEnv(env = process.env) {
  const on = ["1", "true", "yes"].includes(String(env.LOGMEM_MIRROR_ACMI || "").toLowerCase());
  const spaces = String(env.LOGMEM_MIRROR_SPACES || "madez").split(",").map((s) => s.trim()).filter(Boolean);
  return { enabled: on, spaces };
}

const retryKey = (space) => `lm:${space}:mirror:retry`;

const toHashValue = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));

export function createMirror(redis, space, { now = Date.now } = {}) {
  async function typeOf(key) {
    return String((await redis("TYPE", key)) || "none").toLowerCase();
  }

  /** Add the id to the ACMI list index only when the index is a SET (or absent). */
  async function indexAcmi(ns, id) {
    const key = acmiIndexKey(space, ns);
    const t = await typeOf(key);
    if (t === "none" || t === "set") await redis("SADD", key, id);
  }

  const apply = {
    async log({ ns, id, entry }) {
      const { _o, ...clean } = entry;
      const twin = { ...entryToAcmi(clean), mirrored_from: MIRROR_MARK };
      await redis("ZADD", acmiKey(space, ns, id, "log"), clean.ts, JSON.stringify(twin));
      await indexAcmi(ns, id);
    },
    async now({ ns, id, fields }) {
      const key = acmiKey(space, ns, id, "now");
      const t = await typeOf(key);
      if (t === "hash") {
        const pairs = Object.entries(fields).flatMap(([f, v]) => [f, toHashValue(v)]);
        if (pairs.length) await redis("HSET", key, ...pairs);
      } else {
        // ACMI signals are a JSON string; merge so ACMI-only fields survive.
        const cur = t === "string" ? tryParse(await redis("GET", key)) : null;
        const base = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
        await redis("SET", key, JSON.stringify({ ...base, ...fields }));
      }
      await indexAcmi(ns, id);
    },
    async who({ ns, id, doc }) {
      await redis("SET", acmiKey(space, ns, id, "who"), JSON.stringify(doc));
      await indexAcmi(ns, id);
    },
  };

  async function attempt(op) {
    await apply[op.slot](op);
  }

  async function enqueue(op, error) {
    const t = now();
    await redis("ZADD", retryKey(space), t, JSON.stringify({ ...op, queued_at: t, error: String(error).slice(0, 200) }));
  }

  return {
    space,

    /** Mirror one write. Never throws; returns "ok" or "failed" (queued). */
    async write(op) {
      try {
        await attempt(op);
        return "ok";
      } catch (e) {
        try {
          await enqueue(op, e.message);
        } catch {
          // even the queue is unreachable; the daily check will catch it
        }
        return "failed";
      }
    },

    /** Retry up to `max` queued twins. Returns { retried, cleared, left }. */
    async drain(max = 50) {
      const rows = (await redis("ZRANGE", retryKey(space), 0, max - 1)) || [];
      let cleared = 0;
      for (const m of rows) {
        const op = tryParse(m);
        try {
          await attempt(op);
          await redis("ZREM", retryKey(space), m);
          cleared++;
        } catch {
          // stays queued
        }
      }
      const left = Number(await redis("ZCARD", retryKey(space))) || 0;
      return { retried: rows.length, cleared, left };
    },

    async pending() {
      return Number(await redis("ZCARD", retryKey(space))) || 0;
    },
  };
}
