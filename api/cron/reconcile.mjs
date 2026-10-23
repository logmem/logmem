// GET /api/cron/reconcile — close jobs whose work is done, with evidence (src/core/reconcile.mjs).
//
// Runs daily from Vercel Cron (vercel.json), and every 15 minutes from the
// fleet's scheduler through scripts/reconcile.mjs. Dry by default: it reports
// what it would close and changes nothing. It closes only when
// LOGMEM_RECONCILE_MODE=on, and never when the request asks ?dry=1.
//
// Auth: Vercel Cron's `Authorization: Bearer ${CRON_SECRET}`, or a signed-in
// admin (lm_admin cookie), who always gets the dry report.
//
//   200 { ok, mode: "dry"|"on", spaces: [{ space, github, closes, reopens, suggestions, stale, skipped, applied? }] }
//
// Env: LOGMEM_RECONCILE_SPACES (default "madez"), LOGMEM_GITHUB_REPO (default
// "madezmedia/logmem"), LOGMEM_GITHUB_TOKEN (optional, read-only; without it
// the public API is used, and if GitHub can't be read the PR signal is off).

import { fromDescriptor, descriptorFromEnv } from "../../src/lib/backend.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";
import { isAdmin } from "../../src/http/admin-auth.mjs";
import { cronAuthorized, CRON_SECRET_MIN } from "./dogfood-check.mjs";
import { runReconcile } from "../../scripts/reconcile.mjs";

export const config = { runtime: "nodejs", maxDuration: 120 };
const ROUTE = "/api/cron/reconcile";
const SPACE_RE = /^[a-z0-9_-]{1,60}$/;

export function reconcileSpaces(env = process.env) {
  const given = String(env.LOGMEM_RECONCILE_SPACES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const spaces = given.length ? [...new Set(given)] : ["madez"];
  for (const s of spaces) if (!SPACE_RE.test(s)) throw new Error("LOGMEM_RECONCILE_SPACES: bad space name");
  return spaces;
}

function defaultRedis(env) {
  const d = descriptorFromEnv(env);
  return (d && fromDescriptor(d)?.redis) || null;
}

export function createHandler({ env = process.env, resolveRedis = defaultRedis, now = () => Date.now(), fetchImpl, sink } = {}) {
  return async function handler(req, res) {
    const t0 = Date.now();
    res.setHeader("Cache-Control", "no-store");
    const secret = env.CRON_SECRET;
    const viaCron = !!secret && String(secret).length >= CRON_SECRET_MIN && cronAuthorized(req, secret);
    const viaAdmin = !viaCron && isAdmin(req, env);
    if (!viaCron && !viaAdmin) return res.status(401).json({ error: "unauthorized" });
    if (req.method && !["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method not allowed" });
    }
    try {
      const url = new URL(req.url || ROUTE, "https://logmem.local");
      const apply = viaCron && env.LOGMEM_RECONCILE_MODE === "on" && url.searchParams.get("dry") !== "1";
      const redis = resolveRedis(env);
      if (!redis) return res.status(503).json({ error: "reconcile backend not configured on this deployment" });
      const spaces = [];
      for (const space of reconcileSpaces(env)) {
        spaces.push({ space, ...(await runReconcile(redis, { space, apply, env, now: now(), fetchImpl })) });
      }
      logRequest({ route: ROUTE, method: req.method, ms: Date.now() - t0, ok: true, status: 200 }, sink ? { sink } : {});
      return res.status(200).json({ ok: true, mode: apply ? "on" : "dry", ran_at: new Date(now()).toISOString(), spaces });
    } catch (e) {
      return sendServerError(res, ROUTE, e, sink ? { sink } : {});
    }
  };
}

export default createHandler();
