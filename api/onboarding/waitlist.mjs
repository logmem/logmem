// POST /api/onboarding/waitlist {email, agents, plan} -> {ok:true}
//
// The LogMem Cloud waitlist. Hosted spaces and billing don't exist yet, so
// this is the whole Cloud path for now.
//
// Storage: SET lm:onboard:waitlist:<sha256> <json> EX <retention>, plus a
// zset index lm:onboard:waitlist:index scored by expiry. The json keeps the
// email (that is what we contact) and the same sha256 beside it (dedupe).
// Idempotent: a repeat signup keeps the first ts and the original expiry, so
// re-posting does not extend retention. Expired rows are deleted on the next
// signup. The index is capped at WAITLIST_MAX live rows.
//
// Abuse limits: body at most 1 KB; email shape-checked, trimmed, lowercased
// and at most 254 chars; agents an integer 1-10000 (else null); plan from
// the pricing ladder (else null); 10 requests per IP per minute
// (lm:onboard:rl:wl:{ip}). The reply is always {ok:true} on success and
// never says whether the email was already on the list.

import { createHash } from "node:crypto";
import { KEYS, serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, sweepIndex, UNAVAILABLE } from "../../src/http/onboarding.mjs";
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
  log,
} = {}) {
  return async function handler(req, res) {
    const t0 = performance.now();
    noStore(res);
    const done = (status, body) => {
      res.status(status).json(body);
      logRequest({ route: ROUTE, method: req.method, ms: performance.now() - t0, ok: status < 400, status }, log ? { sink: log } : {});
    };
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
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
      const { expired } = await sweepIndex(redis, KEYS.waitlistIndex, nowSec);
      for (const id of expired) {
        if (FIELD_RE.test(id)) await redis("DEL", KEYS.waitlistEntry(id));
      }

      const entryKey = KEYS.waitlistEntry(field);
      const prevRaw = await redis("GET", entryKey);
      if (prevRaw) {
        let prev = null;
        try {
          prev = JSON.parse(prevRaw);
        } catch {
          prev = null;
        }
        const expiredRow = prev && Number.isFinite(prev.exp) && prev.exp <= nowMs;
        if (!expiredRow) {
          // Keep the first ts and the original retention. A repeat must not
          // push the expiry out, or the cap would never apply to that address.
          const ts = Number.isFinite(prev?.ts) ? prev.ts : nowMs;
          const exp = Number.isFinite(prev?.exp) && prev.exp > nowMs ? prev.exp : nowMs + ttlS * 1000;
          const remain = Math.max(1, Math.ceil((exp - nowMs) / 1000));
          await redis("SET", entryKey, JSON.stringify({ email, hash: field, agents, plan, ts, exp }), "EX", String(remain));
          await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(exp / 1000)), field);
          return done(200, { ok: true });
        }
        await redis("DEL", entryKey);
        await redis("ZREM", KEYS.waitlistIndex, field);
      }

      const live = Number(await redis("ZCARD", KEYS.waitlistIndex)) || 0;
      if (live >= maxEntries) return done(503, { error: "waitlist is full" });
      const exp = nowMs + ttlS * 1000;
      await redis("SET", entryKey, JSON.stringify({ email, hash: field, agents, plan, ts: nowMs, exp }), "EX", String(ttlS));
      await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(exp / 1000)), field);
      return done(200, { ok: true });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
