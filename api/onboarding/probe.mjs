// /api/onboarding/probe — pairing drop box for public/probe.sh.
//
//   POST {code, agents:[{name, version}]}   201 {ok:true}
//        409 when the code was already used (write-once)
//   GET  ?code=ABC123                        200 {agents:[...]} or 404
//
// Abuse limits:
//   - code must match ^[A-Z0-9]{6}$ (the onboarding page makes it with
//     crypto.getRandomValues)
//   - body at most 2 KB; at most one entry per allowlisted agent name, unknown
//     names dropped; versions are at most 40 printable ASCII characters
//   - stored with SET NX EX 600 under lm:onboard:probe:{code}: write-once and
//     gone after 10 minutes
//   - 10 POSTs and 40 GETs per IP per minute. GET is higher because the setup
//     page polls every 3 seconds (~20/min) and may be open in a second tab.
//   - at most PROBE_LIVE_CAP pairing keys alive at once (lm:onboard:probe:live
//     scores are the expiry second; expired members are dropped on each call).
//     The sweep, the count, and the SET NX / ZADD run under lm:onboard:lock:probe
//     so overlapping requests cannot all pass the count and all insert.
//   - nothing else in the body is read, stored or echoed; responses are no-store
//
// What lands here is only command names and `--version` output. The script
// never reads config files or environment variables.

import { KEYS, serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, sweepIndex, withStoreLock, StoreLockError, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

const ROUTE = "/api/onboarding/probe";
export const MAX_BODY = 2048;
export const TTL_S = 600;
export const CODE_RE = /^[A-Z0-9]{6}$/;
export const PROBE_POST_LIMIT = 10;
export const PROBE_GET_LIMIT = 40;
export const PROBE_LIVE_CAP = 1000;
export const AGENT_NAMES = ["claude", "codex", "cursor", "gemini", "opencode", "aider", "goose", "cline", "windsurf"];
const ALLOWED = new Set(AGENT_NAMES);
const VERSION_RE = /^[\x20-\x7E]{0,40}$/;

/**
 * Keep only allowlisted names (first occurrence wins) and clean versions.
 * A version that is not a string of <= 40 printable characters becomes "".
 */
export function cleanAgents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const a of list.slice(0, 32)) {
    if (!a || typeof a !== "object") continue;
    const name = typeof a.name === "string" ? a.name.trim().toLowerCase() : "";
    if (!ALLOWED.has(name) || seen.has(name)) continue;
    seen.add(name);
    const v = typeof a.version === "string" ? a.version.trim() : "";
    out.push({ name, version: VERSION_RE.test(v) ? v : "" });
  }
  return out;
}

async function dropExpired(redis, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const { expired, live } = await sweepIndex(redis, KEYS.probeLive, nowSec);
  for (const code of expired) {
    if (CODE_RE.test(code)) await redis("DEL", KEYS.probe(code));
  }
  return { nowSec, live };
}

export function createHandler({ redis: getRedis = () => serverRedis(), now = () => Date.now(), liveCap = PROBE_LIVE_CAP, log } = {}) {
  return async function handler(req, res) {
    const t0 = performance.now();
    noStore(res);
    const done = (status, body) => {
      res.status(status).json(body);
      logRequest({ route: ROUTE, method: req.method, ms: performance.now() - t0, ok: status < 400, status }, log ? { sink: log } : {});
    };
    if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, "GET, POST");
    const redis = getRedis();
    if (!redis) return done(503, { error: UNAVAILABLE });
    try {
      const posting = req.method === "POST";
      const rl = await rateLimit(redis, clientIp(req), {
        bucket: posting ? "probe-post" : "probe-get",
        limit: posting ? PROBE_POST_LIMIT : PROBE_GET_LIMIT,
      });
      if (!rl.ok) {
        res.setHeader("Retry-After", "60");
        return done(429, { error: "too many requests" });
      }

      if (!posting) {
        const code = String(req.query?.code || "");
        if (!CODE_RE.test(code)) return done(400, { error: "bad code" });
        await dropExpired(redis, now());
        const raw = await redis("GET", KEYS.probe(code));
        if (!raw) return done(404, { error: "not found" });
        let stored;
        try {
          stored = JSON.parse(raw);
        } catch {
          return done(404, { error: "not found" });
        }
        // Re-clean on the way out: the key space is ours, but never trust it blindly.
        return done(200, { agents: cleanAgents(stored?.agents) });
      }

      let body;
      try {
        body = readJsonBody(req, MAX_BODY);
      } catch (e) {
        if (e instanceof BodyError) return done(e.status, { error: e.message });
        throw e;
      }
      const code = typeof body.code === "string" ? body.code : "";
      if (!CODE_RE.test(code)) return done(400, { error: "bad code" });
      const agents = cleanAgents(body.agents);
      const ts = now();
      const value = JSON.stringify({ agents, ts });
      const key = KEYS.probe(code);
      let outcome;
      try {
        // One holder at a time: the live count and the insert are one step.
        outcome = await withStoreLock(redis, KEYS.probeLock, async () => {
          const { nowSec, live } = await dropExpired(redis, ts);
          if (await redis("GET", key)) return { status: 409, error: "code already used" };
          if (live >= liveCap) return { status: 429, error: "probe capacity reached", retryAfter: String(TTL_S) };
          const set = await redis("SET", key, value, "NX", "EX", String(TTL_S));
          if (set !== "OK") return { status: 409, error: "code already used" };
          await redis("ZADD", KEYS.probeLive, String(nowSec + TTL_S), code);
          return { status: 201, body: { ok: true } };
        });
      } catch (e) {
        if (e instanceof StoreLockError) {
          res.setHeader("Retry-After", "1");
          return done(429, { error: "too many requests" });
        }
        throw e;
      }
      if (outcome.retryAfter) res.setHeader("Retry-After", outcome.retryAfter);
      return done(outcome.status, outcome.body ?? { error: outcome.error });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
