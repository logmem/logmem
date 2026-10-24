import { withCustomerDashboard } from '../src/http/customer-dashboard.mjs';
// POST /api/decide {space, trail, verdict, note?, confirm?} — a person answers an ask.
//
// Approving an irreversible ask (anything not marked reversible: true) needs
// confirm: "approve", the word the person typed in the confirm dialog;
// without it the answer is 428 and nothing is written.
//
// The one write path from the web app. Everything else in /app reads through
// the read-only guard; this route holds the read-write backend and does one
// thing: writeDecision(), which appends a "decided" entry (by human:admin,
// payload.verdict) to the ask's log and the asker's log and clears the
// asker's now.waiting_on. Agents cannot write "decided" at all. The decider
// is human:<LOGMEM_ADMIN_ID> (default human:admin); an ask addressed to a
// different person (logmem_ask to=human:<id>) is refused with 403.
//
// Gates, in order:
//   1. POST only.
//   2. Signed-in admin (HMAC cookie from /api/login). Required everywhere,
//      not only in production: this route writes.
//   3. CSRF: header "X-LogMem-Intent: decide" (a cross-site form or a simple
//      fetch cannot set it without a CORS preflight, which this route never
//      answers) plus a same-origin check on Origin when the browser sends it.
//      The cookie is SameSite=Lax on top.
//   4. space must be one of viewSpaces().
//   5. The ask must exist and must not already have a person's answer.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { webStore } from "../src/http/web-store.mjs";
import { writeDecision, DecisionError, VERDICTS, LIMITS } from "../src/core/tools.mjs";
import { isAdmin, adminEnabled, viewSpaces } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export const INTENT_HEADER = "x-logmem-intent";
const STATUS = { stale_ask: 409, bad_request: 400, forbidden: 403, not_found: 404, not_pending: 409, ambiguous: 409, confirm_required: 428, misconfigured: 503 };

/** The signed-in person: human:<LOGMEM_ADMIN_ID> (default "admin"). Asks addressed to someone else are refused (403). */
export const deciderFrom = (env) => `human:${String(env.LOGMEM_ADMIN_ID || "admin")}`;

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true; // same-origin fetches may omit it; the intent header still gates
  try {
    return new URL(origin).host === String(req.headers?.host || "");
  } catch {
    return false;
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Testable core. deps: { env, redis } — redis is a read-write runner; when
 * omitted it comes from the deploy's storage descriptor.
 */
export async function decide(req, res, { env = process.env, redis, now } = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  if (!adminEnabled(env)) return res.status(401).json({ error: "admin app is off: LOGMEM_ADMIN_PASSWORD is not set" });
  if (!isAdmin(req, env)) return res.status(401).json({ error: "sign in required" });
  if (String(req.headers?.[INTENT_HEADER] || "") !== "decide" || !sameOrigin(req)) {
    return res.status(403).json({ error: "missing or wrong X-LogMem-Intent header (expected 'decide' from this site)" });
  }

  const b = body(req);
  if (!b) return res.status(400).json({ error: "JSON body required: {space, trail, verdict, note?, confirm?}" });
  const { space, trail, verdict, note, confirm, expected_hash } = b;
  if (typeof space !== "string" || !viewSpaces(env).includes(space)) {
    return res.status(403).json({ error: `space '${String(space)}' is not shown here`, spaces: viewSpaces(env) });
  }
  if (typeof trail !== "string" || !trail || trail.length > LIMITS.trail) return res.status(400).json({ error: `trail required, max ${LIMITS.trail} characters` });
  if (!VERDICTS.includes(verdict)) return res.status(400).json({ error: `verdict must be one of ${VERDICTS.join(", ")}` });
  if (note != null && (typeof note !== "string" || note.length > LIMITS.summary)) return res.status(400).json({ error: `note must be text, max ${LIMITS.summary} characters` });

  let runner = redis;
  if (!runner) {
    const d = descriptorFromEnv(env);
    if (!d) return res.status(503).json({ error: "storage not configured on this deployment" });
    runner = fromDescriptor(d).redis;
  }
  try {
    const store = webStore(runner, space, env); // mirrored, so a decision is never a dogfood mirror mismatch
    const out = await writeDecision(store, trail, { verdict, note: note || undefined, by: deciderFrom(env), via: "web", confirm: confirm === "approve", reclaim: true, expectedHash: expected_hash, ...(now ? { now } : {}) });
    return res.status(201).json({ ok: true, space, ...out });
  } catch (e) {
    if (e instanceof DecisionError) return res.status(STATUS[e.code] || 400).json({ error: e.message, code: e.code });
    return sendServerError(res, "/api/decide", e);
  }
}

function handler(req, res) {
  return decide(req, res);
}

export default withCustomerDashboard(handler);
