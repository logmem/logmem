// apps/dashboard/lib/server/viewer.mjs
// Next.js and Vercel Dashboard server-side viewer adapter.
// Resolves verified customer identity, workspace permissions, and space-jailed storage.
// Enforces strict tenant boundaries and accepts NO caller-supplied Redis credentials.

import { customerSession } from '../../../../src/http/clerk.mjs';
import { customerRedis, createSpaceJail } from '../../../../src/http/jail.mjs';
import { readOnly } from '../../../../src/lib/read-only.mjs';
import { evalScriptFor, registerEvalScript } from '../../../../src/lib/lua-scripts.mjs';
import {
  authorizeSpace,
  workspaceVersionKey,
  WorkspaceError,
  listWorkspaces,
  listSpaces
} from '../../../../src/http/workspaces.mjs';

const FORBIDDEN_OPTIONS = [
  'redis',
  'redisUri',
  'callerRedis',
  'redisCredential',
  'tenantId',
  'namespace',
  'role',
  'person',
  'userId',
  'token'
];

const VALID_ACTIONS = new Set([
  'read',
  'write',
  'approve',
  'manage-members',
  'manage-connections',
  'create-space'
]);

const scripts = new Map();

function guardedScript(original) {
  if (scripts.has(original)) return scripts.get(original);
  const source = `
local expected = ARGV[#ARGV]
local workspace = KEYS[#KEYS-1]
local tenant = KEYS[#KEYS]
if redis.call('GET',workspace) ~= expected or redis.call('HGET',tenant,'status') ~= 'active' or redis.call('HGET',tenant,'deleted_at') then return redis.error_reply('space access changed') end
table.remove(KEYS)
table.remove(KEYS)
table.remove(ARGV)
${original || 'return redis.call(unpack(ARGV))'}
`;
  registerEvalScript(source, (call, keys, args) => {
    if (call('GET', keys.at(-2)) !== args.at(-1) || call('HGET', keys.at(-1), 'status') !== 'active' || call('HGET', keys.at(-1), 'deleted_at')) {
      throw new WorkspaceError('not_found', 404);
    }
    const ks = keys.slice(0, -2), as = args.slice(0, -1);
    return original ? evalScriptFor(original)(call, ks, as) : call(...as);
  });
  scripts.set(original, source);
  return source;
}

/**
 * Resolves the authenticated viewer context for the Next.js dashboard.
 * 
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {string} options.spaceId
 * @param {string} [options.action='read']
 * @param {object} [options.req] - Optional request or headers envelope
 * @param {object} [deps] - Server-level dependency injection (redis, env, session)
 * @returns {Promise<object>} DashboardViewerContext
 */
export async function resolveDashboardViewer(options = {}, deps = {}) {
  // 1. Strict rejection of caller-supplied credentials or identity overrides
  for (const key of FORBIDDEN_OPTIONS) {
    if (key in options && options[key] !== undefined) {
      throw new WorkspaceError('unauthorized_credential_override', 403);
    }
  }

  const { workspaceId, spaceId, action = 'read', req = {} } = options;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new WorkspaceError('missing_workspace_id', 400);
  }
  if (!spaceId || typeof spaceId !== 'string') {
    throw new WorkspaceError('missing_space_id', 400);
  }
  if (!VALID_ACTIONS.has(action)) {
    throw new WorkspaceError('invalid_action', 400);
  }

  const env = deps.env || process.env;
  if (env.LOGMEM_CUSTOMER_DASHBOARD !== '1' && !deps.redis) {
    throw new WorkspaceError('customer_dashboard_disabled', 503);
  }

  // 2. Resolve verified human identity from Clerk session
  const origin = deps.origin || `https://${req.headers?.host || 'logmem.si'}`;
  const session = await (deps.session || customerSession)(req, {
    env,
    url: new URL('/api/session', origin).toString()
  });

  if (session.status !== 'signed-in' || !session.userId) {
    throw new WorkspaceError('sign_in_required', 401);
  }

  const userId = session.userId;
  // Authoritative server storage: accepts NO caller credential
  const redis = deps.redis || customerRedis(env);

  // 3. Authorize membership and space role
  const authOpts = { userId, workspaceId, spaceId, action };
  const context = await authorizeSpace(authOpts, { redis });

  // 4. Invariant revalidation hook
  const revalidate = async () => {
    const fresh = await authorizeSpace(authOpts, { redis });
    if (fresh.version !== context.version) {
      throw new WorkspaceError('not_found', 404);
    }
    return fresh;
  };

  // 5. Build guarded and space-jailed Redis runner
  const run = async (...cmd) => {
    let keys, args, source;
    if (String(cmd[0]).toUpperCase() === 'EVAL') {
      const n = Number(cmd[2]);
      keys = cmd.slice(3, 3 + n);
      args = cmd.slice(3 + n);
      source = guardedScript(cmd[1]);
    } else {
      keys = [];
      args = cmd;
      source = guardedScript('');
    }
    try {
      return await redis(
        'EVAL',
        source,
        keys.length + 2,
        ...keys,
        workspaceVersionKey(workspaceId),
        `acmi:cloud:tenant:${context.workspace.tenantId}`,
        ...args,
        String(context.version)
      );
    } catch (e) {
      if (String(e.message).includes('space access changed')) {
        throw new WorkspaceError('not_found', 404);
      }
      throw e;
    }
  };

  const jailed = createSpaceJail(run, {
    tenantId: context.workspace.tenantId,
    namespace: context.space.namespace
  });

  const permissions = {
    ...context.permissions,
    canWrite: Boolean(context.permissions.write),
    canApprove: Boolean(context.permissions.approve),
    canManage: Boolean(context.permissions.manage),
    canManageMembers: Boolean(context.permissions.manage),
    canManageConnections: Boolean(context.permissions.manage),
    canCreateSpace: context.membership?.role !== 'viewer'
  };

  return {
    ...context,
    userId,
    person: `human:${userId}`,
    workspaceId,
    spaceId,
    namespace: context.space.namespace,
    role: context.membership?.role || 'member',
    permissions,
    workspace: context.workspace,
    space: context.space,
    redis: action === 'read' ? readOnly(jailed) : jailed,
    revalidate
  };
}

/**
 * Returns all workspaces and spaces authorized for the current viewer.
 */
export async function listViewerWorkspaces(userId, deps = {}) {
  const env = deps.env || process.env;
  const redis = deps.redis || customerRedis(env);
  const workspaces = await listWorkspaces({ userId }, { redis });
  const result = [];
  for (const w of workspaces) {
    const spaces = await listSpaces({ userId, workspaceId: w.id }, { redis });
    result.push({ ...w, spaces });
  }
  return result;
}
