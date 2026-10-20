// /api/invites — a person invites waitlist sign-ups to the managed beta.
//
//   GET                     -> { open, invites: [{ hash, ts, by }] }   (hashes only, never emails)
//   POST { emails: [...] }  -> { invited, already, invalid }
//
// Gates, in order: a signed-in admin, then for POST the header
// "X-LogMem-Intent: invites" plus a same-origin check (the /api/decide rule).
// Invites live on the customer Redis (LOGMEM_CUSTOMER_REDIS_URI).

import { inviteMany, listInvites, signupOpen, InviteError } from "../src/http/invites.mjs";
import { customerRedis, CustomerRedisConfigError } from "../src/http/jail.mjs";
import { isAdmin } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };
export const INTENT = "invites";

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers?.host || "");
  } catch {
    return false;
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(String(req.body || ""));
  } catch {
    return null;
  }
}

export function createHandler({ env = process.env, redis = () => customerRedis(env), now } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!isAdmin(req, env)) return res.status(401).json({ error: "sign in required" });
    try {
      if (req.method === "GET") return res.status(200).json({ open: signupOpen(env), invites: await listInvites({ redis: redis() }) });
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b) return res.status(400).json({ error: "JSON body required" });
      const by = `human:${String(env.LOGMEM_ADMIN_ID || "admin")}`;
      return res.status(200).json(await inviteMany(b.emails, { redis: redis(), by, ...(now ? { now } : {}) }));
    } catch (e) {
      if (e instanceof InviteError) return res.status(400).json({ error: e.message });
      if (e instanceof CustomerRedisConfigError) return res.status(503).json({ error: "the customer Redis is not configured on this deploy" });
      return sendServerError(res, "invites", e);
    }
  };
}

export default createHandler();
