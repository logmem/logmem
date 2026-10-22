// /api/agent-keys — a person creates, lists and revokes per-agent LogMem keys.
//
//   GET                         -> { keys: [{ id, space, agent, label, created_at, created_by }] }
//   POST { space, agent, label } -> { id, key, space, agent, ... }   (the key is shown once)
//   POST { action: "revoke", id } -> { revoked: true|false }
//   GET also returns web: [{ fid, app, agent, space, created_at, last_used }], the web
//   clients an admin connected to a fleet space through the OAuth sign-in page.
//   POST { action: "disconnect", fid } -> { disconnected: true|false }: every token of that grant goes.
//
// Gates, in order: a signed-in admin (cookie from /api/login), then for writes
// the header "X-LogMem-Intent: agent-keys" plus a same-origin check (the same
// CSRF rule as /api/decide). Responses are never cached. The key itself is
// returned only in the create response and is never stored or logged.

import { createAgentKey, listAgentKeys, revokeAgentKey, AgentKeyError, keySpaces } from "../src/http/agent-keys.mjs";
import { deployRedis, StorageConfigError, listManagedApps, revokeManagedApp, FLEET_OWNER } from "./oauth/_lib/storage.mjs";
import { isAdmin } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };
export const INTENT = "agent-keys";

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers?.host || "");
  } catch {
    return false;
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(String(req.body || ""));
  } catch {
    return null;
  }
}

export function createHandler({ env = process.env, redis = () => deployRedis(), now } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!isAdmin(req, env)) return res.status(401).json({ error: "sign in required" });
    try {
      if (req.method === "GET") {
        // Web connections live in the OAuth store; if it is not set up, the keys list still works.
        const web = (await listManagedApps(FLEET_OWNER).catch(() => [])).map((a) => ({ fid: a.fid, app: a.client_name || "App", agent: a.agent, space: a.space || null, created_at: a.created_at, last_used: a.last_used }));
        return res.status(200).json({ keys: await listAgentKeys({ redis: redis() }), spaces: keySpaces(env), web });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b) return res.status(400).json({ error: "JSON body required" });
      if (b.action === "revoke") return res.status(200).json({ revoked: await revokeAgentKey(b.id, { redis: redis() }) });
      if (b.action === "disconnect") return res.status(200).json({ disconnected: !!(await revokeManagedApp(FLEET_OWNER, String(b.fid || ""))) });
      const by = `human:${String(env.LOGMEM_ADMIN_ID || "admin")}`;
      const out = await createAgentKey({ space: b.space, agent: b.agent, label: b.label, by }, { env, redis: redis(), ...(now ? { now } : {}) });
      return res.status(201).json(out);
    } catch (e) {
      if (e instanceof AgentKeyError) return res.status(400).json({ error: e.message });
      if (e instanceof StorageConfigError) return res.status(503).json({ error: "key storage is not configured on this deploy" });
      return sendServerError(res, "agent-keys", e);
    }
  };
}

export default createHandler();
