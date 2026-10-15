// POST /api/onboarding/waitlist {email, agents, plan, attribution} -> {ok:true}
//
// The LogMem Cloud waitlist. Hosted spaces and billing don't exist yet, so
// this is the whole Cloud path for now.
//
// Storage is in src/http/waitlist-store.mjs: one row per email with no
// expiry and no cap, written with SET NX so no global lock is needed. Every
// sign-up is also added to a stream that is never trimmed, and, when a Blob
// store is connected (BLOB_READ_WRITE_TOKEN), written as one private JSON
// file. A failed copy never fails the sign-up.
//
// Abuse limits: body at most 2 KB; email shape-checked, trimmed, lowercased
// and at most 254 chars; agents an integer 1-10000 (else null); plan from
// the pricing ladder (else null); attribution cut and cleaned, never a reason
// to refuse; 30 requests per IP per minute (lm:onboard:rl:wl:{ip}). The reply
// is always {ok:true} on success and never says whether the email was
// already on the list.

import { createHash } from "node:crypto";
import { serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, WAITLIST_RATE_LIMIT, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { saveSignup, envBlobPut } from "../../src/http/waitlist-store.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

const ROUTE = "/api/onboarding/waitlist";
export const MAX_BODY = 2048;
export const PLANS = ["free", "dev", "pro", "team", "agency", "enterprise"];
// Kept for importers. The waitlist no longer has a cap or an expiry.
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

/**
 * `blobPut` left undefined means: use the deployment's Blob store when one is
 * connected. Tests pass a fake, or null for none.
 */
export function createHandler({
  redis: getRedis = () => serverRedis(),
  now = () => Date.now(),
  blobPut,
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
      const rl = await rateLimit(redis, clientIp(req), { bucket: "wl", limit: WAITLIST_RATE_LIMIT });
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
      if (!FIELD_RE.test(emailKey(email))) return done(400, { error: "enter a valid email address" });
      await saveSignup(redis, {
        email,
        agents: cleanAgents(body.agents),
        plan: PLANS.includes(body.plan) ? body.plan : null,
        attribution: body.attribution,
        now: now(),
        blobPut: blobPut === undefined ? envBlobPut() : blobPut,
        log,
      });
      return done(200, { ok: true });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
