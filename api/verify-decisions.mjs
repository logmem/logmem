// POST /api/verify-decisions: which signed web decisions verify (answered-means-answered).
//
// Local agents (stdio on a Mac) hold no decision signing key, so they could
// not tell a real web decision from a forged one, and every answer read as
// "unverified". This server holds the key. It answers only which decisions
// verify. It never returns or derives the key, and it reads and writes no data.
//
//   POST { space, decisions: [{ origin, ask_hash, verdict, note, by, ts, sig }] }
//   200  { valid: [index, ...] }        indexes into `decisions`
//   400  bad body   405 not POST   503 no signing key on this deploy
//
// No sign-in: an HMAC answer of valid or invalid gives nothing to forge with,
// and a caller can only ask about decisions it already holds. At most 200 per call.

import { verifyWireDecisions, REMOTE_VERIFY_MAX, DECIDE_SECRET_MIN } from "../src/core/tools.mjs";
import { validateKeySegments } from "../src/lib/helpers.mjs";
import { logRequest } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

export default async function handler(req, res, { env = process.env } = {}) {
  const t0 = Date.now();
  const done = (status, body) => {
    logRequest({ route: "/api/verify-decisions", method: req.method, ms: Date.now() - t0, ok: status < 400, status });
    res.status(status).setHeader("Cache-Control", "no-store").json(body);
  };
  if (req.method !== "POST") return done(405, { error: "method_not_allowed" });
  const secret = env.LOGMEM_DECIDE_SECRET;
  if (typeof secret !== "string" || secret.length < DECIDE_SECRET_MIN) return done(503, { error: "verification unavailable" });
  const body = req.body && typeof req.body === "object" ? req.body : null;
  const space = String(body?.space ?? "");
  try {
    validateKeySegments(space);
  } catch {
    return done(400, { error: "space required" });
  }
  if (!Array.isArray(body.decisions) || body.decisions.length > REMOTE_VERIFY_MAX) {
    return done(400, { error: `decisions must be an array of at most ${REMOTE_VERIFY_MAX}` });
  }
  return done(200, { valid: verifyWireDecisions(space, body.decisions, secret) });
}
