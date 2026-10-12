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
//   - nothing else in the body is read, stored or echoed; responses are no-store
//
// What lands here is only command names and `--version` output. The script
// never reads config files or environment variables.

import { KEYS, serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

const ROUTE = "/api/onboarding/probe";
export const MAX_BODY = 2048;
export const TTL_S = 600;
export const CODE_RE = /^[A-Z0-9]{6}$/;
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

export function createHandler({ redis: getRedis = () => serverRedis(), log } = {}) {
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
      if (req.method === "GET") {
        const code = String(req.query?.code || "");
        if (!CODE_RE.test(code)) return done(400, { error: "bad code" });
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
      const value = JSON.stringify({ agents, ts: Date.now() });
      const set = await redis("SET", KEYS.probe(code), value, "NX", "EX", String(TTL_S));
      if (set !== "OK") return done(409, { error: "code already used" });
      return done(201, { ok: true });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
