// POST /api/spaces { slug, name } — create a space (WS1).
// GET  /api/spaces       — list the spaces this identity belongs to.
//
// Auth: same resolver as /api/mcp and /api/inbox (OAuth bearer, agent key,
// config, direct token). The creating identity becomes owner. The registry is
// the logmem-redis store; without its env every call fails closed with 503.
import { resolveAuth, decodeConfig, wwwAuthenticate } from "../src/http/auth.mjs";
import { sendServerError } from "../src/http/log.mjs";
import { createSpace, listSpaces, registryRedis, SpaceError, spaceKey, membersKey, memberIndexKey } from "../src/http/spaces.mjs";
import { attachSpace, listWorkspaces as listUserWorkspaces, WorkspaceError } from "../src/http/workspaces.mjs";
import { customerRedis } from "../src/http/jail.mjs";

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

      // Phase 2: a human creator's space attaches to their workspace so /app
      // shows the card. Attach failures compensate the registry — an
      // unattached registry record must never be left behind. Agent keys and
      // direct tokens have no workspace: registry-only, workspace null.
      let workspace = null;
      const isPerson = /^user_[A-Za-z0-9]{10,64}$/.test(identity);
      if (b.workspaceId || isPerson) {
        let wsRedis = null;
        try { wsRedis = deps.workspaceRedis || customerRedis(deps.env || process.env); } catch { wsRedis = null; }
        if (!wsRedis && b.workspaceId) {
          await compensate(registry, rec, identity);
          throw new SpaceError("workspace_unavailable", 503, "workspace store is not configured; an explicit workspaceId cannot be honored");
        }
        if (wsRedis) {
          try {
            let target = b.workspaceId;
            if (!target) {
              const owned = await listUserWorkspaces({ userId: identity }, { redis: wsRedis });
              target = (owned.find((w) => w.role === "owner" || w.role === "admin") || owned[0] || {}).id;
            }
            if (target) {
              const a = await attachSpace({ userId: identity, workspaceId: target, space: rec, requestId: `attach-${rec.slug}` }, { redis: wsRedis, now: deps.now });
              workspace = { id: target, attached: a.attached !== false, spaceId: a.space.id, namespace: a.space.namespace, backend: "api" };
              rec.workspace = target;
              await registry("SET", spaceKey(rec.slug), JSON.stringify(rec));
            }
          } catch (e) {
            await compensate(registry, rec, identity);
            throw e;
          }
        }
      }
      return res.status(201).json({ ok: true, space: rec, workspace });
    } catch (e) {
      if (e instanceof SpaceError) return res.status(e.status).json({ error: e.code, message: e.message });
      if (e instanceof WorkspaceError) return res.status(e.status || 400).json({ error: e.code, message: e.message });
      return sendServerError(res, "/api/spaces", e);
    }
  };
}

async function compensate(registry, rec, identity) {
  try { await registry("DEL", spaceKey(rec.slug), membersKey(rec.slug), memberIndexKey(identity)); } catch { /* best effort */ }
}

export default createHandler();
