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
import { adminIdentity } from "../src/http/admin-auth.mjs";
import { ROLES, getRole, setRole, suspendUser, unsuspendUser, listRoles, suspendedList, audit, activeRole } from "../src/http/admin-roles.mjs";
import { createClerkClient } from "@clerk/backend";
import { deployRedis } from "./oauth/_lib/storage.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };
export const INTENT = "admin-users";

// Live per-action authorization. READ_ROLES gates the GET list; ACTION_ROLES
// gates each POST action. A role missing from an action's list cannot call it,
// whatever the cookie says.
const READ_ROLES = new Set(["admin", "support"]);
const ACTION_ROLES = {
  "set-role": ["admin"],
  suspend: ["admin"],
  unsuspend: ["admin"],
  sessions: ["admin", "support"],
  revoke_session: ["admin", "support"],
};

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
      const actorId = adminIdentity(req, env);
      if (!actorId) return res.status(401).json({ error: "sign in required" });
      // P1 fix (Mikey review 2026-10-31): the cookie is never enough. The role
      // and suspension behind this identity are read live on every request, so
      // a demotion or suspension bites on the next call, not at cookie expiry.
      const me = await activeRole(actorId, redis());
      if (me.suspended) return res.status(403).json({ error: "account_suspended" });
      if (!me.role) return res.status(403).json({ error: "no_role", hint: "an admin must set-role this account first" });
      if (req.method === "GET") {
        if (!me.breakglass && !READ_ROLES.has(me.role)) return res.status(403).json({ error: "role_not_authorized", role: me.role });
        return res.status(200).json({ ok: true, roles: await listRoles(redis()), suspended: await suspendedList(redis()), allowed_roles: ROLES });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b) return res.status(400).json({ error: "JSON body required" });
      // Per-action role matrix. Only the admin role may change roles or
      // suspend; admin and support share session visibility. Break-glass
      // (the operator password) passes every gate by design and is the
      // documented recovery path for a suspended admin.
      const need = ACTION_ROLES[String(b.action || "")];
      if (need && !me.breakglass && !need.includes(me.role)) {
        await audit(redis(), { action: "authz:denied", attempt: String(b.action || "?"), role: me.role, by: actorId });
        return res.status(403).json({ error: "role_not_authorized", role: me.role, needs: need });
      }
      if (b.action === "sessions") {
        const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
        const page = await clerk.sessions.getSessionList({});
        const sessions = (page?.data || []).map((x) => ({ id: x.id, user_id: x.userId ?? x.user_id, status: x.status, last_active_at: x.lastActiveAt ?? x.last_active_at, created_at: x.createdAt ?? x.created_at }));
        await audit(redis(), { action: "sessions:list", count: sessions.length, by: actorId });
        return res.status(200).json({ ok: true, sessions });
      }
      if (b.action === "revoke_session") {
        if (!b.sessionId || !/^sess_/.test(String(b.sessionId))) throw new WorkspaceError("invalid_session", 400);
        const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
        await clerk.sessions.revokeSession(String(b.sessionId));
        await audit(redis(), { action: "session:revoke", target: String(b.sessionId), by: actorId });
        return res.status(200).json({ ok: true, revoked: b.sessionId });
      }
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
