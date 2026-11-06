// POST /api/spaces/:slug/invite { identity, role } — add or re-role a member.
//
// Roles: owner / admin / member. Only an owner or admin of the space may
// invite; the actor is bound from the authenticated identity, never from the
// body. Registry reads and writes fail closed with 503 when the store is not
// configured on this deploy.
import { resolveAuth, decodeConfig, wwwAuthenticate } from "../../../src/http/auth.mjs";
import { sendServerError } from "../../../src/http/log.mjs";
import { invite, registryRedis, SpaceError } from "../../../src/http/spaces.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
    try {
      const auth = await (deps.resolveAuth || resolveAuth)(req, deps.decodeConfig ? deps.decodeConfig(req) : decodeConfig(req));
      if (!auth.backend && !auth.injected) {
        res.setHeader("WWW-Authenticate", wwwAuthenticate(req));
        return res.status(401).json({ error: "authentication required" });
      }
      const actor = auth.sub || "break-glass";
      const registry = deps.registry || registryRedis(deps.env || process.env);
      const slug = String(req.query?.slug || "");
      const b = req.body || {};
      const rec = await invite({ slug, identity: b.identity, role: b.role, actor, redis: registry });
      return res.status(200).json({ ok: true, ...rec });
    } catch (e) {
      if (e instanceof SpaceError) return res.status(e.status).json({ error: e.code, message: e.message });
      return sendServerError(res, "/api/spaces/invite", e);
    }
  };
}

export default createHandler();
