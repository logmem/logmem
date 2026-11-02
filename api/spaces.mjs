// POST /api/spaces { slug, name } — create a space (WS1).
// GET  /api/spaces       — list the spaces this identity belongs to.
//
// Auth: same resolver as /api/mcp and /api/inbox (OAuth bearer, agent key,
// config, direct token). The creating identity becomes owner. The registry is
// the logmem-redis store; without its env every call fails closed with 503.
import { resolveAuth, decodeConfig, wwwAuthenticate } from "../src/http/auth.mjs";
import { sendServerError } from "../src/http/log.mjs";
import { createSpace, listSpaces, registryRedis, SpaceError } from "../src/http/spaces.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(204).end();
    try {
      const auth = await (deps.resolveAuth || resolveAuth)(req, deps.decodeConfig ? deps.decodeConfig(req) : decodeConfig(req));
      if (!auth.backend && !auth.injected) {
        res.setHeader("WWW-Authenticate", wwwAuthenticate(req));
        return res.status(401).json({ error: "authentication required" });
      }
      const identity = auth.sub || "break-glass";
      const registry = deps.registry || registryRedis(deps.env || process.env);

      if (req.method === "GET") {
        const spaces = await listSpaces({ identity, redis: registry });
        return res.status(200).json({ ok: true, identity, spaces });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
      const b = req.body || {};
      const rec = await createSpace({ slug: b.slug, name: b.name, actor: identity, redis: registry, now: deps.now });
      return res.status(201).json({ ok: true, space: rec });
    } catch (e) {
      if (e instanceof SpaceError) return res.status(e.status).json({ error: e.code, message: e.message });
      return sendServerError(res, "/api/spaces", e);
    }
  };
}

export default createHandler();
