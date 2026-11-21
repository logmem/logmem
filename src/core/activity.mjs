// activity.mjs: one per-space index of every log entry, newest first, for the Activity page.
// Job activity-index-feed. Before this, Activity scanned up to 300 log keys and read 100
// entries from each, so a busy space showed an incomplete, unordered window.
//
// lm:{space}:activity is a ZSET scored by entry ts. Each member is a small row: the entry
// fields the view needs plus `at`, the log it was written to. The store adds a row on every
// append, re-adds it on repair and removes it with the entry. Rows are capped per space.

export const activityKey = (space) => `lm:${space}:activity`;
export const ACTIVITY_CAP = 5000;
const TRIM_EVERY = 50;

const stableJson = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`
    : Array.isArray(v) ? `[${v.map(stableJson).join(",")}]` : JSON.stringify(v ?? null);

/**
 * The row stored for one entry. Keeps exactly what the view's slim() reads, including the
 * entry's own `where` (the ask digest hashes it). `at` is the log the entry lives in.
 */
export function activityRow(ns, id, e) {
  const row = {
    at: `${ns}:${id}`, ts: Number(e.ts), kind: e.kind, by: e.by, via: e.via, summary: e.summary,
    trail: e.trail, origin: e.origin, to: e.to, where: e.where,
  };
  if (e.kind === "approval") {
    row.action = e.action;
    row.reversible = e.reversible;
  }
  if (e.kind === "decided") {
    const p = e.payload || {};
    row.payload = { verdict: p.verdict ?? null, note: p.note ?? null, ask_hash: p.ask_hash ?? null, sig: p.sig ?? null };
  }
  if (e.legacy === true) row.legacy = true;
  return row;
}

export const activityMember = (ns, id, e) => stableJson(activityRow(ns, id, e));

/** Add one entry to the index. Idempotent: the same entry maps to the same member. */
export async function indexActivity(redis, space, ns, id, entry, { random = Math.random } = {}) {
  await redis("ZADD", activityKey(space), Number(entry.ts), activityMember(ns, id, entry));
  if (random() < 1 / TRIM_EVERY) await trimActivity(redis, space).catch(() => {});
}

export async function unindexActivity(redis, space, ns, id, entry) {
  return Number(await redis("ZREM", activityKey(space), activityMember(ns, id, entry))) || 0;
}

/** Keep the newest `cap` rows. */
export async function trimActivity(redis, space, cap = ACTIVITY_CAP) {
  return Number(await redis("ZREMRANGEBYRANK", activityKey(space), 0, -(cap + 1))) || 0;
}

const parseRows = (flat) => {
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    try {
      const row = JSON.parse(flat[i]);
      if (row && typeof row === "object" && typeof row.at === "string") out.push({ ...row, ts: Number(flat[i + 1]) });
    } catch {
      /* a malformed member is skipped, never shown */
    }
  }
  return out;
};

/**
 * One page of the index, newest first. `cursor` is the highest ts to include (from the
 * previous page's next_cursor). A page never splits one millisecond, so paging neither
 * repeats nor skips an entry. An entry written to several logs (a handoff, an ask) shows
 * once, where the work lives, the same rule the scan used.
 *
 * Returns null when the index is empty, so the caller can fall back to the scan.
 */
export async function activityPage(redis, space, { limit = 200, cursor = null, digest = () => "" } = {}) {
  const key = activityKey(space);
  const max = cursor == null ? "+inf" : String(cursor);
  const fetchN = limit * 3;
  let rows = parseRows(await redis("ZREVRANGEBYSCORE", key, max, "-inf", "WITHSCORES", "LIMIT", 0, fetchN));
  if (!rows.length) {
    if (cursor != null) return { rows: [], next_cursor: null, oldest: await oldestIndexed(redis, space) };
    return null;
  }
  // A full fetch may have cut the oldest millisecond: drop it, it starts the next page.
  const full = rows.length === fetchN;
  if (full) {
    const edge = rows.at(-1).ts;
    const inner = rows.filter((x) => x.ts !== edge);
    if (inner.length) rows = inner;
  }
  // Job and channel rows first within one ts, so a duplicate keeps where the work lives.
  rows.sort((a, b) => b.ts - a.ts || (a.at.startsWith("agent:") ? 1 : 0) - (b.at.startsWith("agent:") ? 1 : 0));
  const seen = new Set();
  rows = rows.filter((x) => {
    const sig = `${x.ts}|${x.trail}|${x.summary}${x.kind === "approval" ? `|${digest(x)}` : ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  let more = full;
  if (rows.length > limit) {
    const edge = rows[limit - 1].ts;
    rows = rows.filter((x) => x.ts >= edge);
    more = true;
  }
  return { rows, next_cursor: more && rows.length ? String(rows.at(-1).ts - 1) : null, oldest: await oldestIndexed(redis, space) };
}

export async function oldestIndexed(redis, space) {
  const r = await redis("ZRANGE", activityKey(space), 0, 0, "WITHSCORES");
  return r && r.length >= 2 ? Number(r[1]) : null;
}

/** Parse a client cursor: a non-negative integer ms, else null. */
export function parseCursor(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
