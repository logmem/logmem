// GET /api/cron/dogfood-check — the daily dogfood audit, run by Vercel Cron
// (vercel.json "crons", 13:00 UTC). Replaces the GitHub Actions workflow as the
// primary path; no GitHub dependency.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` on cron calls.
//   CRON_SECRET unset (or under 32 chars) -> 503, nothing runs (fail closed).
//   header missing or wrong              -> 401.
//
// For each space in LOGMEM_DOGFOOD_SPACES (default "madez,fieldnotes"; a blank
// or empty value is unset and uses that default) it runs the same runCheck as
// scripts/dogfood-check.mjs against the server's env backend, writes the
// checkup as agent:logmem-check, and stores the scorecard in Redis at
// lm:{space}:dogfood:scorecard. A second run of this handler on the same UTC
// day replaces that day's checkup and scorecard row (no duplicates). The
// Actions workflow does not: it checks out feat/dogfood-phase0, which appends.
//
// Mirror parity is checked for LOGMEM_DOGFOOD_MIRROR_SPACES (default "madez"),
// the same as the workflow's --mirror-spaces madez.
//
// Errors: the client gets a generic 500 with a ref; detail goes to the log.

import { createHash, timingSafeEqual } from "node:crypto";
import { fromDescriptor, descriptorFromEnv } from "../../src/lib/backend.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";
import { runDaily } from "../../scripts/dogfood-check.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

const ROUTE = "/api/cron/dogfood-check";
export const CRON_SECRET_MIN = 32;
const SPACE_RE = /^[a-z0-9_-]{1,60}$/;

const list = (v, d) => String(v ?? d).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Spaces to check. A nullish, blank, or empty list is unset and uses the
 * design default (madez, fieldnotes): those are the two dogfood spaces, and a
 * day the check does not run is a gap. An explicit name is kept. A malformed
 * name throws (a config error, not a request error).
 */
export function dogfoodSpaces(env = process.env) {
  const given = list(env.LOGMEM_DOGFOOD_SPACES, "");
  const spaces = [...new Set(given.length ? given : list(null, "madez,fieldnotes"))];
  for (const s of spaces) if (!SPACE_RE.test(s)) throw new Error(`LOGMEM_DOGFOOD_SPACES: bad space name (${s.length} chars)`);
  return spaces;
}

export const mirrorSpaces = (env = process.env) => list(env.LOGMEM_DOGFOOD_MIRROR_SPACES, "madez");

const digest = (s) => createHash("sha256").update(String(s)).digest();

/** Constant-time check of the Authorization header against the secret. */
export function cronAuthorized(req, secret) {
  const h = req.headers?.authorization;
  if (typeof h !== "string" || !h) return false;
  return timingSafeEqual(digest(h), digest(`Bearer ${secret}`));
}

function defaultRedis(env) {
  const d = descriptorFromEnv(env);
  return (d && fromDescriptor(d)?.redis) || null;
}

/** Handler factory (tests inject env, redis and clock). */
export function createHandler({ env = process.env, resolveRedis = defaultRedis, now = () => Date.now(), sink } = {}) {
  return async function handler(req, res) {
    const t0 = Date.now();
    res.setHeader("Cache-Control", "no-store");
    const secret = env.CRON_SECRET;
    if (!secret || String(secret).length < CRON_SECRET_MIN) {
      return res.status(503).json({ error: "cron disabled: CRON_SECRET is not set on this deployment" });
    }
    if (!cronAuthorized(req, secret)) return res.status(401).json({ error: "unauthorized" });
    if (req.method && !["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method not allowed" });
    }
    try {
      const spaces = dogfoodSpaces(env);
      const redis = resolveRedis(env);
      if (!redis) return res.status(503).json({ error: "dogfood backend not configured on this deployment" });
      const mirrors = mirrorSpaces(env);
      const at = now();
      const results = [];
      let failure = null;
      for (const space of spaces) {
        try {
          const r = await runDaily(redis, { space, mirrorSpaces: mirrors, now: at });
          results.push(r.skipped
            ? { space, skipped: r.skipped }
            : { space, date: r.date, pass: r.pass, replaced: r.replaced, gate: r.card.gate });
        } catch (e) {
          // Keep going: one bad space must not cost the other its day.
          failure ||= e;
          logRequest({ route: ROUTE, method: req.method, ok: false, status: 500, err: `${space}: ${e?.message || e}` }, sink ? { sink } : {});
          results.push({ space, ok: false });
        }
      }
      if (failure) return sendServerError(res, ROUTE, failure, sink ? { sink } : {});
      logRequest({ route: ROUTE, method: req.method, ms: Date.now() - t0, ok: true, status: 200 }, sink ? { sink } : {});
      return res.status(200).json({ ok: true, ran_at: new Date(at).toISOString(), results });
    } catch (e) {
      return sendServerError(res, ROUTE, e, sink ? { sink } : {});
    }
  };
}

export default createHandler();
