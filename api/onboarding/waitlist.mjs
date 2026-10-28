// POST /api/onboarding/waitlist {email, agents, plan} -> {ok:true}
//
// The LogMem Cloud waitlist. Hosted spaces and billing don't exist yet, so
// this is the whole Cloud path for now.
//
// Storage: SET lm:onboard:waitlist:<sha256> <json> EX <retention>, plus a
// zset index lm:onboard:waitlist:index scored by expiry. The json keeps the
// email (that is what we contact) and the same sha256 beside it (dedupe).
// Idempotent: a repeat signup keeps the first ts and the original expiry, so
// re-posting does not extend retention. Expired index members and their
// payload keys are deleted before the cap check. The index is capped at
// WAITLIST_MAX live rows. The dedupe read, the live count, and the insert run
// under lm:onboard:lock:waitlist, and the holder token is read again
// immediately before the write, so overlapping signups cannot all pass the
// count and all insert. A stored value that is not valid JSON takes that same
// cap path instead of being treated as a row already on the list.
//
// Abuse limits: body at most 1 KB; email shape-checked, trimmed, lowercased
// and at most 254 chars; agents an integer 1-10000 (else null); plan from
// the pricing ladder (else null); 10 requests per IP per minute
// (lm:onboard:rl:wl:{ip}). The reply is always {ok:true} on success and
// never says whether the email was already on the list.

import { createHash } from "node:crypto";
import { KEYS, serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, sweepIndex, withStoreLock, StoreLockError, LOCK_BUSY_ERROR, LOCK_RETRY_AFTER_S, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { isAdmin } from "../../src/http/admin-auth.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

const ROUTE = "/api/onboarding/waitlist";
export const MAX_BODY = 1024;
export const PLANS = ["free", "dev", "pro", "team", "agency", "enterprise"];
export const WAITLIST_MAX = 10000;
export const WAITLIST_TTL_S = 180 * 24 * 60 * 60;
const FIELD_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Lowercased, trimmed email if it has a plausible shape, else null. */
export function normalizeEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  if (!/\.[a-z]{2,}$/.test(e)) return null; // TLD of letters
  return e;
}

export const emailKey = (email) => createHash("sha256").update(email).digest("hex");

function cleanAgents(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : null;
}

export function createHandler({
  redis: getRedis = () => serverRedis(),
  now = () => Date.now(),
  maxEntries = WAITLIST_MAX,
  ttlS = WAITLIST_TTL_S,
  lockWaitMs,
  log,
  env = process.env,
} = {}) {
  return async function handler(req, res) {
    const t0 = performance.now();
    noStore(res);
    const done = (status, body) => {
      res.status(status).json(body);
      logRequest({ route: ROUTE, method: req.method, ms: performance.now() - t0, ok: status < 400, status }, log ? { sink: log } : {});
    };
    if (req.method === "GET") {
      if (!isAdmin(req, env)) return done(401, { error: "unauthorized" });
      const redis = getRedis();
      if (!redis) return done(503, { error: UNAVAILABLE });
      try {
        const rows = await listWaitlist(redis);
        return done(200, rows);
      } catch (e) {
        sendServerError(res, ROUTE, e, log ? { sink: log } : {});
        return;
      }
    }
    if (req.method !== "POST") return methodNotAllowed(res, "GET, POST");
    const redis = getRedis();
    if (!redis) return done(503, { error: UNAVAILABLE });
    try {
      const rl = await rateLimit(redis, clientIp(req), { bucket: "wl" });
      if (!rl.ok) {
        res.setHeader("Retry-After", "60");
        return done(429, { error: "too many requests" });
      }
      let body;
      try {
        body = readJsonBody(req, MAX_BODY);
      } catch (e) {
        if (e instanceof BodyError) return done(e.status, { error: e.message });
        throw e;
      }
      const email = normalizeEmail(body.email);
      if (!email) return done(400, { error: "enter a valid email address" });
      const plan = PLANS.includes(body.plan) ? body.plan : null;
      const agents = cleanAgents(body.agents);
      const field = emailKey(email);
      if (!FIELD_RE.test(field)) return done(400, { error: "enter a valid email address" });

      const nowMs = now();
      const nowSec = Math.floor(nowMs / 1000);
      const entryKey = KEYS.waitlistEntry(field);
      // Payload expiry is outside the lock. Only the count and the insert
      // need to be the only writer.
      const { expired } = await sweepIndex(redis, KEYS.waitlistIndex, nowSec);
      for (const id of expired) {
        if (FIELD_RE.test(id)) await redis("DEL", KEYS.waitlistEntry(id));
      }
      let outcome;
      try {
        // One holder at a time: the live count and the insert are one step.
        // A repeat of an address already stored still updates inside the lock,
        // so a full list does not reject that address.
        outcome = await withStoreLock(redis, KEYS.waitlistLock, async (lock) => {
          const prevRaw = await redis("GET", entryKey);
          if (prevRaw) {
            let prev = null;
            let unparseable = false;
            try {
              prev = JSON.parse(prevRaw);
            } catch {
              unparseable = true;
            }
            const expiredRow = !unparseable && prev && Number.isFinite(prev.exp) && prev.exp <= nowMs;
            if (!unparseable && !expiredRow) {
              // Keep the first ts and the original retention. A repeat must not
              // push the expiry out, or the cap would never apply to that address.
              const ts = Number.isFinite(prev?.ts) ? prev.ts : nowMs;
              const exp = Number.isFinite(prev?.exp) && prev.exp > nowMs ? prev.exp : nowMs + ttlS * 1000;
              const remain = Math.max(1, Math.ceil((exp - nowMs) / 1000));
              await lock.requireHeld();
              await redis("SET", entryKey, JSON.stringify({ email, hash: field, agents, plan, ts, exp }), "EX", String(remain));
              await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(exp / 1000)), field);
              return { status: 200 };
            }
            // Expired, or not JSON: drop it and admit through the cap below.
            await lock.requireHeld();
            await redis("DEL", entryKey);
            await redis("ZREM", KEYS.waitlistIndex, field);
          }

          const live = Number(await redis("ZCARD", KEYS.waitlistIndex)) || 0;
          if (live >= maxEntries) return { status: 503 };
          const exp = nowMs + ttlS * 1000;
          await lock.requireHeld();
          await redis("SET", entryKey, JSON.stringify({ email, hash: field, agents, plan, ts: nowMs, exp }), "EX", String(ttlS));
          await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(exp / 1000)), field);
          return { status: 200 };
        }, lockWaitMs == null ? undefined : { waitMs: lockWaitMs });
      } catch (e) {
        if (e instanceof StoreLockError) {
          res.setHeader("Retry-After", String(LOCK_RETRY_AFTER_S));
          return done(429, { error: LOCK_BUSY_ERROR });
        }
        throw e;
      }
      if (outcome.status === 503) return done(503, { error: "waitlist is full" });
      return done(200, { ok: true });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export async function listWaitlist(redis) {
  const keys = [];
  let cursor = "0";
  do {
    const res = await redis("SCAN", cursor, "MATCH", "lm:onboard:waitlist:*", "COUNT", "200");
    const batch = Array.isArray(res) ? res : [];
    cursor = String(batch[0] ?? "0");
    const found = Array.isArray(batch[1]) ? batch[1] : [];
    for (const k of found) keys.push(String(k));
  } while (cursor !== "0");
  const rows = [];
  for (const key of keys) {
    if (key === KEYS.waitlistIndex) continue;
    if (key === KEYS.waitlistLock) continue;
    if (key.includes(":lock:") || key.includes(":rl:")) continue;
    let raw;
    try {
      raw = await redis("GET", key);
    } catch {
      continue;
    }
    if (raw == null) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    rows.push(parsed);
  }
  rows.sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0));
  return rows;
}

export default createHandler();
