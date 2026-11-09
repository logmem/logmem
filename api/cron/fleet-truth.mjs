// GET/POST /api/cron/fleet-truth — scheduled birds-eye refresh for channel:fleet-truth.
// Auth: Authorization: Bearer ${CRON_SECRET} (min 32 chars). Fail closed.
import { getSecret } from "../../src/lib/secrets.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { fromDescriptor, descriptorFromEnv } from "../../src/lib/backend.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";
import { runOnce } from "../../src/fleet-truth/run.mjs";

export const config = { runtime: "nodejs", maxDuration: 300 };

const ROUTE = "/api/cron/fleet-truth";
export const CRON_SECRET_MIN = 32;
const SPACE_RE = /^[a-z0-9_-]{1,60}$/;

const list = (v, d) => String(v ?? d).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function fleetTruthSpaces(env = process.env) {
  const given = list(env.LOGMEM_FLEET_TRUTH_SPACES, "");
  const spaces = [...new Set(given.length ? given : list(null, "madez"))];
  for (const s of spaces) if (!SPACE_RE.test(s)) throw new Error(`LOGMEM_FLEET_TRUTH_SPACES: bad space name (${s.length} chars)`);
  return spaces;
}

const digest = (s) => createHash("sha256").update(String(s)).digest();

export function cronAuthorized(req, secret) {
  const h = req.headers?.authorization;
  if (typeof h !== "string" || !h) return false;
  return timingSafeEqual(digest(h), digest(`Bearer ${secret}`));
}

function defaultRedis(env) {
  const d = descriptorFromEnv(env);
  return (d && fromDescriptor(d)?.redis) || null;
}

export function createHandler({ env = process.env, resolveRedis = defaultRedis, now = () => Date.now(), sink } = {}) {
  return async function handler(req, res) {
    const t0 = Date.now();
    res.setHeader("Cache-Control", "no-store");
    const secret = getSecret("CRON_SECRET", env);
    if (!secret || String(secret).length < CRON_SECRET_MIN) {
      return res.status(503).json({ error: "cron disabled: CRON_SECRET is not set on this deployment" });
    }
    if (!cronAuthorized(req, secret)) return res.status(401).json({ error: "unauthorized" });
    if (req.method && !["GET", "POST"].includes(req.method)) {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method not allowed" });
    }
    try {
      const spaces = fleetTruthSpaces(env);
      const redis = resolveRedis(env);
      if (!redis) return res.status(503).json({ error: "fleet-truth backend not configured on this deployment" });
      const at = now();
      const results = [];
      let failure = null;
      for (const space of spaces) {
        try {
          const r = await runOnce(redis, {
            space,
            nowMs: at,
            seedWho: true,
            probes: env.LOGMEM_FLEET_TRUTH_PROBES,
            mirror: space === "madez",
          });
          results.push(r.skipped
            ? { space, skipped: r.skipped, trail: r.trail }
            : { space, ok: true, trail: r.trail, summary: r.summary });
        } catch (e) {
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
