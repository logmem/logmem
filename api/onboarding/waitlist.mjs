// POST /api/onboarding/waitlist {email, agents, plan} -> {ok:true}
//
// The LogMem Cloud waitlist. Hosted spaces and billing don't exist yet, so
// this is the whole Cloud path for now.
//
// Storage: HSET lm:onboard:waitlist <sha256(lowercased email)> <json>, where
// json = {email, agents, plan, ts}. Idempotent: a repeat signup keeps the
// first ts, so the same request twice leaves the same record.
//
// Abuse limits: body at most 1 KB; email shape-checked and at most 254 chars;
// agents an integer 1-10000 (else null); plan from the pricing ladder (else
// null); 10 requests per IP per minute (lm:onboard:rl:wl:{ip}). The reply is
// always {ok:true} on success and never says whether the email was already
// on the list.

import { createHash } from "node:crypto";
import { KEYS, serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

const ROUTE = "/api/onboarding/waitlist";
export const MAX_BODY = 1024;
export const PLANS = ["free", "dev", "pro", "team", "agency", "enterprise"];
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

export function createHandler({ redis: getRedis = () => serverRedis(), now = () => Date.now(), log } = {}) {
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
      let ts = now();
      const prev = await redis("HGET", KEYS.waitlist, field);
      if (prev) {
        try {
          const p = JSON.parse(prev);
          if (Number.isFinite(p?.ts)) ts = p.ts;
        } catch {
          /* overwrite a damaged record */
        }
      }
      await redis("HSET", KEYS.waitlist, field, JSON.stringify({ email, agents, plan, ts }));
      return done(200, { ok: true });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
