// src/http/fleet-admin.mjs — Mount Fleet spaces (e.g. madez) for Clerk-authenticated deploy admins.
//
// Security model:
//   - Requires a verified Clerk userId AND live `requireAdminAuth(userId, customerRedis, { allowedRoles: ['admin'] })`
//     (checks lm:admin:role:{userId} === 'admin' and lm:admin:suspended:{userId} on EVERY request).
//   - Requires a configured Fleet backend via descriptorFromEnv(env).
//   - Only exposes spaces explicitly listed in LOGMEM_VIEW_SPACES / LOGMEM_SPACE (defaulting to ['madez']
//     when a Fleet backend is configured).
//   - Never accepts caller-supplied Redis credentials.

import { descriptorFromEnv, fromDescriptor } from "../lib/backend.mjs";
import { requireAdminAuth } from "./admin-roles.mjs";
import { WorkspaceError } from "./workspaces.mjs";
import { validateSpaceName } from "./space-export.mjs";

export const FLEET_WORKSPACE_ID = "fleet";

const FLEET_ALLOWED_ACTIONS = new Set([
  "read",
  "write",
  "approve",
  "export-space",
  "import-space",
]);

export function fleetSpaces(env = process.env) {
  if (!descriptorFromEnv(env)) return [];
  const raw = String(env.LOGMEM_VIEW_SPACES || env.LOGMEM_SPACE || "madez");
  const out = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    try {
      validateSpaceName(s);
      if (!out.includes(s)) out.push(s);
    } catch {
      // ignore invalid entries
    }
  }
  return out;
}

export function fleetPermissions() {
  return {
    read: true,
    write: true,
    approve: true,
    manage: false,
    exportSpace: true,
    importSpace: true,
    shareSnapshot: false,
    transferSpace: false,
    canWrite: true,
    canApprove: true,
    canManage: false,
    canManageMembers: false,
    canManageConnections: false,
    canCreateSpace: false,
    canExport: true,
    canImport: true,
    canShareSnapshot: false,
    canTransfer: false,
  };
}

/**
 * Returns the virtual Fleet (Admin) workspace for a Clerk-signed-in deploy admin,
 * or null if the user is not an active deploy admin or no Fleet backend is configured.
 */
export async function listFleetAdminWorkspace(userId, { redis, env = process.env } = {}) {
  if (!userId || !redis) return null;
  const spaces = fleetSpaces(env);
  if (spaces.length === 0) return null;
  const auth = await requireAdminAuth(userId, redis, { allowedRoles: ["admin"] });
  if (!auth.ok) return null;

  const perms = fleetPermissions();
  return {
    id: FLEET_WORKSPACE_ID,
    tenantId: FLEET_WORKSPACE_ID,
    name: "Fleet (Admin)",
    status: "active",
    createdAt: 0,
    version: 1,
    businessType: "",
    plan: "fleet",
    role: "owner",
    isFleetAdmin: true,
    spaces: spaces.map((s) => ({
      id: s,
      workspaceId: FLEET_WORKSPACE_ID,
      namespace: s,
      name: s === "madez" ? "madez (Fleet Admin)" : `${s} (Fleet Admin)`,
      status: "active",
      createdAt: 0,
      permissions: perms,
    })),
  };
}

/**
 * Authorize and resolve a Fleet Redis runner for a Clerk-signed-in deploy admin.
 * Throws WorkspaceError('forbidden' | 'not_found' | 'backend_unavailable') on failure.
 */
export async function resolveFleetAdminAccess(
  { userId, spaceId, action = "read" },
  { redis, env = process.env, fleetRedis = null } = {},
) {
  if (!userId || !redis) throw new WorkspaceError("sign_in_required", 401);
  const auth = await requireAdminAuth(userId, redis, { allowedRoles: ["admin"] });
  if (!auth.ok) {
    throw new WorkspaceError(auth.error === "account_suspended" ? "account_suspended" : "forbidden", auth.status || 403);
  }
  const spaces = fleetSpaces(env);
  if (!spaces.includes(spaceId)) {
    throw new WorkspaceError("not_found", 404);
  }
  if (!FLEET_ALLOWED_ACTIONS.has(action)) {
    throw new WorkspaceError("forbidden", 403);
  }

  let runner = fleetRedis;
  if (!runner) {
    const desc = descriptorFromEnv(env);
    const backend = desc ? fromDescriptor(desc) : null;
    if (!backend?.redis) throw new WorkspaceError("backend_unavailable", 503);
    runner = backend.redis;
  }

  const adminId = String(env.LOGMEM_ADMIN_ID || "admin").trim() || "admin";
  const perms = fleetPermissions();
  return {
    userId,
    person: `human:${adminId}`,
    workspaceId: FLEET_WORKSPACE_ID,
    spaceId,
    namespace: spaceId,
    role: "owner",
    isFleetAdmin: true,
    version: 1,
    permissions: perms,
    workspace: {
      id: FLEET_WORKSPACE_ID,
      tenantId: FLEET_WORKSPACE_ID,
      name: "Fleet (Admin)",
      status: "active",
      plan: "fleet",
    },
    space: {
      id: spaceId,
      workspaceId: FLEET_WORKSPACE_ID,
      namespace: spaceId,
      name: spaceId === "madez" ? "madez (Fleet Admin)" : `${spaceId} (Fleet Admin)`,
      status: "active",
    },
    fleetRedis: runner,
    revalidate: async () => {
      const fresh = await requireAdminAuth(userId, redis, { allowedRoles: ["admin"] });
      if (!fresh.ok) throw new WorkspaceError("forbidden", 403);
      return fresh;
    },
  };
}
