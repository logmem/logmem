// waitlist-store.mjs: how a waitlist sign-up is kept.
//
// Redis is the system of record. One string per email, with no expiry:
//   SET lm:onboard:waitlist:<sha256> <json> NX
//   ZADD lm:onboard:waitlist:index <first sign-up second> <sha256>
// SET NX is one atomic command, so two first sign-ups for the same email
// cannot both create a row, and different emails never wait on each other.
// A repeat keeps the first ts and the first attribution, and updates plan,
// agents, last_ts and count.
//
// Two copies follow, and neither can fail the sign-up:
//   - XADD lm:onboard:waitlist:log, one entry per sign-up, never trimmed.
//   - blobPut, when a Blob store is connected: one JSON file per sign-up.
// A copy that fails logs a fixed message only: never the email, the IP or
// an attribution value.
//
// Old rows ({email, hash, agents, plan, ts, exp}) still parse. A repeat
// rewrites them in the new shape without EX, which clears the old expiry.

import { createHash } from "node:crypto";
import { KEYS } from "./onboarding.mjs";
import { logRequest } from "./log.mjs";

const ROUTE = "/api/onboarding/waitlist";
const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
const MAX_VALUE = 100;
const MAX_PATH = 200;
export const BLOB_TIMEOUT_MS = 3000;

/**
 * Reduce a value to [A-Za-z0-9._~/-]. Accents are dropped first, so "Café"
 * becomes "Cafe". Every other run of characters becomes one "-". The result
 * is cut to `max`; nothing left is null.
 */
function cleanValue(v, max) {
  if (typeof v !== "string") return null;
  const s = v
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._~/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || null;
}

/** Host only, lowercased. Takes a full URL or a bare host name. */
function cleanHost(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  let host = v.trim();
  try {
    host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return host.slice(0, MAX_VALUE) || null;
}

/** Path only: the query and fragment can carry an email, so both go. */
function cleanPath(v) {
  if (typeof v !== "string") return null;
  const path = v.split(/[?#]/)[0];
  const s = cleanValue(path, MAX_PATH);
  if (!s) return null;
  return s.startsWith("/") ? s : `/${s}`.slice(0, MAX_PATH);
}

/**
 * Where a sign-up came from, cleaned. Bad, long or odd values are cut and
 * cleaned, never a reason to refuse the sign-up. Unknown keys are dropped.
 */
export function cleanAttribution(raw) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of UTM) out[k] = cleanValue(a[k], MAX_VALUE);
  out.referrer_host = cleanHost(a.referrer_host);
  out.landing_path = cleanPath(a.landing_path);
  const seen = Math.floor(Number(a.first_seen));
  out.first_seen = typeof a.first_seen === "number" && Number.isSafeInteger(seen) && seen > 0 ? seen : null;
  return out;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function parseRow(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A copy failed. Fixed text only, so no personal data can reach the log. */
function copyFailed(log, what) {
  logRequest({ route: ROUTE, ok: false, err: `${what} copy failed` }, log ? { sink: log } : {});
}

/**
 * Store one sign-up. `email` must already be normalized. Returns
 * { created } where created is false for a repeat of a stored email.
 */
export async function saveSignup(redis, { email, agents = null, plan = null, attribution = null, now = Date.now(), blobPut = null, blobTimeoutMs = BLOB_TIMEOUT_MS, log } = {}) {
  const hash = sha256(email);
  const key = KEYS.waitlistEntry(hash);
  const attr = cleanAttribution(attribution);
  let row = { email, hash, agents, plan, ts: now, last_ts: now, count: 1, attribution: attr };
  let created = (await redis("SET", key, JSON.stringify(row), "NX")) === "OK";
  if (!created) {
    const prev = parseRow(await redis("GET", key));
    if (prev) {
      // A repeat. Old rows have no count: they stand for one earlier sign-up.
      const count = Number.isSafeInteger(prev.count) && prev.count >= 1 ? prev.count : 1;
      const firstAttr = prev.attribution && typeof prev.attribution === "object" ? prev.attribution : attr;
      row = { email, hash, agents, plan, ts: Number.isFinite(prev.ts) ? prev.ts : now, last_ts: now, count: count + 1, attribution: firstAttr };
    } else {
      // Gone since the NX, or not JSON: this sign-up becomes the row.
      created = true;
    }
    // No EX: this also clears the expiry an old row was written with.
    await redis("SET", key, JSON.stringify(row));
  }
  await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(row.ts / 1000)), hash);

  try {
    await redis("XADD", KEYS.waitlistLog, "*", "hash", hash, "email", email, "plan", plan ?? "", "src", attr.utm_source ?? "", "ts", String(now));
  } catch {
    copyFailed(log, "stream");
  }

  if (blobPut) {
    const day = new Date(now).toISOString().slice(0, 10);
    try {
      await withTimeout(Promise.resolve().then(() => blobPut(`waitlist/${day}/${now}-${hash}.json`, JSON.stringify(row))), blobTimeoutMs);
    } catch {
      copyFailed(log, "blob");
    }
  }
  return { created };
}

/**
 * The Blob writer for this deployment, or null when no Blob store is
 * connected. The SDK loads only when a token is set.
 */
export function envBlobPut(env = process.env) {
  if (!env.BLOB_READ_WRITE_TOKEN) return null;
  return async (path, body) => {
    const { put } = await import("@vercel/blob");
    await put(path, body, { access: "private", contentType: "application/json", addRandomSuffix: false });
  };
}

const FIELD_RE = /^[0-9a-f]{64}$/;
const READ_CHUNK = 200;

/**
 * Every stored sign-up, newest first, flattened for the admin view. Rows come
 * from the index plus one MGET per 200 members. Members whose row is gone (an
 * old row that expired) or is not JSON are skipped. Old rows read with
 * last_ts = ts, count = 1 and no attribution.
 */
export async function listSignups(redis) {
  const raw = await redis("ZRANGE", KEYS.waitlistIndex, "0", "-1");
  const ids = (Array.isArray(raw) ? raw : []).map(String).filter((m) => FIELD_RE.test(m));
  const rows = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const vals = await redis("MGET", ...ids.slice(i, i + READ_CHUNK).map((id) => KEYS.waitlistEntry(id)));
    for (const v of Array.isArray(vals) ? vals : []) {
      const r = v == null ? null : parseRow(v);
      if (!r || typeof r.email !== "string" || !Number.isFinite(r.ts)) continue;
      const a = r.attribution && typeof r.attribution === "object" ? r.attribution : {};
      const str = (x) => (typeof x === "string" && x ? x : null);
      rows.push({
        email: r.email,
        plan: str(r.plan),
        agents: Number.isInteger(r.agents) ? r.agents : null,
        ts: r.ts,
        last_ts: Number.isFinite(r.last_ts) ? r.last_ts : r.ts,
        count: Number.isSafeInteger(r.count) && r.count >= 1 ? r.count : 1,
        utm_source: str(a.utm_source),
        utm_medium: str(a.utm_medium),
        utm_campaign: str(a.utm_campaign),
        referrer_host: str(a.referrer_host),
        landing_path: str(a.landing_path),
      });
    }
  }
  return rows.sort((x, y) => y.ts - x.ts || (x.email < y.email ? -1 : 1));
}
