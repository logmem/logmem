// api/admin-users.mjs — per-account admin roles and suspension (Phase A).
//
//   GET  /api/admin-users                -> { roles, suspended }        (admin cookie)
//   POST /api/admin-users                -> set-role | suspend | unsuspend
//        body { action, userId, role?, reason? }
//        requires X-LogMem-Intent: admin-users and same origin.
//
// Gates, in order: signed-in admin (cookie from /api/login), then the intent
// header plus a same-origin check — the same shape as /api/agent-keys.
// Suspension cascades: fleet keys with this owner are revoked immediately,
// workspace keys and sessions die at their choke points on the next request.
// Attribution is "break-glass" until the identity cookie lands in slice 2,
// so the audit never claims a person who has not been identified.
import { customerRedis } from "../src/http/jail.mjs";
import { WorkspaceError } from "../src/http/workspaces.mjs";
import { isAdmin } from "../src/http/admin-auth.mjs";
import { ROLES, getRole, setRole, suspendUser, unsuspendUser, listRoles, suspendedList } from "../src/http/admin-roles.mjs";
import { deployRedis } from "./oauth/_lib/storage.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };
export const INTENT = "admin-users";

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers?.host || ""); } catch { return false; }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(String(req.body || "")); } catch { return null; }
}

export function createHandler({ env = process.env, redis = () => customerRedis(env), deploy = () => deployRedis(), now } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!isAdmin(req, env)) return res.status(401).json({ error: "sign in required" });
      if (req.method === "GET") {
        return res.status(200).json({ ok: true, roles: await listRoles(redis()), suspended: await suspendedList(redis()), allowed_roles: ROLES });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b) return res.status(400).json({ error: "JSON body required" });
      const actorId = "break-glass"; // slice 2: replace with the identity from the admin session cookie
      if (b.action === "set-role") {
        const r = await setRole({ actorId, userId: b.userId, role: b.role, redis: redis() });
        return res.status(200).json({ ok: true, ...r });
      }
      if (b.action === "suspend") {
        const r = await suspendUser({ actorId, userId: b.userId, reason: b.reason, redis: redis(), deployRedis: deploy() });
        return res.status(200).json({ ok: true, ...r });
      }
      if (b.action === "unsuspend") {
        const r = await unsuspendUser({ actorId, userId: b.userId, redis: redis() });
        return res.status(200).json({ ok: true, ...r });
      }
      throw new WorkspaceError("invalid_action", 400);
    } catch (e) {
      if (e instanceof WorkspaceError) return res.status(e.status).json({ error: e.code });
      if (e instanceof RangeError || /invalid user id|invalid role/.test(String(e?.message))) return res.status(400).json({ error: String(e.message).slice(0, 120) });
      return sendServerError(res, "/api/admin-users", e);
    }
  };
}

export default createHandler();
