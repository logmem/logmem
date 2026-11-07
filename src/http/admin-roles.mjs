// admin-roles.mjs — Phase A slice 1: per-account admin roles, suspension,
// cascade revoke and audit for the admin program (program anchor:
// job:dashboard-user-management, milestone-admin-controls-v1).
//
// Storage lives in the CUSTOMER redis (lm:admin:*) so every customer-side
// choke point can read it with the handle it already has, and admin routes
// reach it through the same jail. Roles are deploy-scoped facts about a
// Clerk user id; suspension is a hard stop, not a suggestion:
//
//   lm:admin:role:{userId}      { role, by, at }        role in ROLES
//   lm:admin:suspended:{userId} { at, by, reason? }     set = blocked
//   lm:admin:audit              ZSET ts -> JSON         every admin action
//
// Cascade on suspend: every fleet agent key whose record carries this owner
// is revoked by id, and lookup choke points refuse suspended owners on the
// next request, so workspace keys and sessions die without a mass rewrite.
// Attribution: the identity cookie lands in slice 2; until then every admin
// action records by = "break-glass" so the audit never pretends.
import { revokeAgentKey } from "./agent-keys.mjs";

export const ROLES = ["admin", "support", "billing", "viewer"];
export const BREAK_GLASS = "break-glass";

const roleKey = (u) => `lm:admin:role:${u}`;
const suspKey = (u) => `lm:admin:suspended:${u}`;
const AUDIT_KEY = "lm:admin:audit";

/** Canonical user id: strip a human: prefix, cap length, require a sane shape. */
export function normUser(userId) {
  const u = String(userId || "").replace(/^human:/, "").slice(0, 64);
  if (!/^(user_[A-Za-z0-9]+|[A-Za-z0-9._-]{1,64})$/.test(u)) throw new Error("invalid user id");
  return u;
}

export async function audit(redis, entry) {
  await redis("ZADD", AUDIT_KEY, Date.now(), JSON.stringify({ at: Date.now(), ...entry }));
}

export async function getRole(userId, redis) {
  const raw = await redis("GET", roleKey(normUser(userId)));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function listRoles(redis) {
  const keys = [];
  let cur = "0";
  do {
    const [next, batch] = await redis("SCAN", cur, "MATCH", "lm:admin:role:*", "COUNT", "100");
    keys.push(...batch);
    cur = next;
  } while (cur !== "0");
  const out = [];
  for (const k of keys) {
    const raw = await redis("GET", k);
    try { const rec = JSON.parse(raw); out.push({ userId: k.slice("lm:admin:role:".length), ...rec }); } catch { /* skip corrupt */ }
  }
  return out;
}

export async function setRole({ actorId, userId, role, redis }) {
  const u = normUser(userId);
  if (!ROLES.includes(role)) throw new Error("invalid role");
  await redis("SET", roleKey(u), JSON.stringify({ role, by: String(actorId || BREAK_GLASS).slice(0, 64), at: Date.now() }));
  await audit(redis, { action: "set-role", target: u, role, by: String(actorId || BREAK_GLASS) });
  return { userId: u, role };
}

/**
 * Live identity check for admin routes: the role and suspension on THIS
 * request, read fresh from redis. A demotion or suspension takes effect on
 * the very next request, so a valid cookie is never enough on its own.
 * Break-glass is the operator password path: full access, attributed as such.
 */
export async function activeRole(actorId, redis) {
  if (actorId === BREAK_GLASS) return { role: "operator", suspended: false, breakglass: true };
  const [role, suspended] = [await getRole(actorId, redis), await isSuspendedSafe(actorId, redis)];
  return { role: role?.role || null, suspended, breakglass: false };
}

export class SuspensionStoreError extends Error {
  constructor(message = "suspension store unavailable") {
    super(message);
    this.name = "SuspensionStoreError";
    this.status = 503;
    this.code = "backend_unavailable";
  }
}

export async function isSuspended(userId, redis) {
  const u = normUser(userId);
  return Number(await redis("EXISTS", suspKey(u))) === 1;
}

/**
 * Front-door variant (fail closed on store errors with 503, Option A):
 * A suspension-store error (NOPERM, timeout, outage) fails closed by throwing
 * SuspensionStoreError (status 503) so unauthorized or suspended actors cannot
 * bypass enforcement during store outages.
 */
export async function isSuspendedSafe(userId, redis) {
  try {
    return await isSuspended(userId, redis);
  } catch (e) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", route: "suspension-guard", code: String(e?.message || e).slice(0, 120), note: "suspension store unavailable, failing closed with 503" }));
    throw new SuspensionStoreError(e?.message || "suspension store unavailable");
  }
}

/**
 * Live role check for admin routes (Layer 1 backend contracts):
 * Verifies live role and suspension state from redis on every request.
 */
export async function requireAdminAuth(actorId, redis, { allowedRoles = null } = {}) {
  if (!actorId) return { ok: false, status: 401, error: "sign in required" };
  if (actorId === BREAK_GLASS) return { ok: true, actorId, role: "operator", breakglass: true };
  if (!redis) return { ok: false, status: 503, error: "roles_backend_unavailable" };
  try {
    const me = await activeRole(actorId, redis);
    if (me.suspended) return { ok: false, status: 403, error: "account_suspended" };
    if (!me.breakglass) {
      if (!me.role) return { ok: false, status: 403, error: "no_role", hint: "an admin must set-role this account first" };
      if (allowedRoles && !allowedRoles.includes(me.role)) {
        return { ok: false, status: 403, error: "role_not_authorized", role: me.role };
      }
    }
    return { ok: true, actorId, ...me };
  } catch (e) {
    return { ok: false, status: 503, error: "suspension_store_unavailable", hint: e?.message || "backend unavailable" };
  }
}

/**
 * Suspend a user: record the stop, then cascade. Returns revoked fleet key
 * ids. Workspace keys and sessions die at their choke points on the next
 * request (lookup and identity read this same record), so no mass rewrite.
 */
export async function suspendUser({ actorId, userId, reason, redis, deployRedis }) {
  const u = normUser(userId);
  await redis("SET", suspKey(u), JSON.stringify({ at: Date.now(), by: String(actorId || BREAK_GLASS).slice(0, 64), reason: String(reason || "").slice(0, 200) }));
  const revoked = [];
  if (deployRedis) {
    let cur = "0";
    do {
      const [next, batch] = await deployRedis("SCAN", cur, "MATCH", "lm:agentkey:h:*", "COUNT", "200");
      for (const k of batch) {
        const raw = await deployRedis("GET", k);
        try {
          const rec = JSON.parse(raw);
          if (rec && rec.owner && normUser(rec.owner) === u) {
            await revokeAgentKey(rec.id, { redis: deployRedis });
            revoked.push(rec.id);
          }
        } catch { /* skip corrupt */ }
      }
      cur = next;
    } while (cur !== "0");
  }
  await audit(redis, { action: "suspend", target: u, revoked_keys: revoked.length, reason: String(reason || "").slice(0, 200), by: String(actorId || BREAK_GLASS) });
  return { userId: u, revoked_keys: revoked };
}

export async function unsuspendUser({ actorId, userId, redis }) {
  const u = normUser(userId);
  const existed = Number(await redis("EXISTS", suspKey(u))) === 1;
  await redis("DEL", suspKey(u));
  if (existed) await audit(redis, { action: "unsuspend", target: u, by: String(actorId || BREAK_GLASS) });
  return { userId: u, restored: existed };
}

/** Scan the customer workspace records for a user's connections is not needed:
 *  workspace keys die at lookupWorkspaceAgentKey, which consults isSuspended. */
export async function suspendedList(redis) {
  const keys = [];
  let cur = "0";
  do {
    const [next, batch] = await redis("SCAN", cur, "MATCH", "lm:admin:suspended:*", "COUNT", "100");
    keys.push(...batch);
    cur = next;
  } while (cur !== "0");
  return keys.map((k) => k.slice("lm:admin:suspended:".length));
}
