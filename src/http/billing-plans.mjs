// billing-plans.mjs — shared Subscription, Billing & Plan Limits control plane
// for both User View (workspace owner/member) and Admin View (deploy admin/billing).
// Strict write validation + relaxed read tolerance.

import crypto from "node:crypto";
import { loadPlans, planFor, namespaceFor } from "../../cloud/tenants/index.mjs";
import { usage as meterUsage, monthKey } from "../../cloud/meter/index.mjs";
import { customerRedis } from "./jail.mjs";
import { customerSession } from "./clerk.mjs";
import { adminIdentity } from "./admin-auth.mjs";
import { activeRole, requireAdminAuth, audit as recordAdminAudit, BREAK_GLASS } from "./admin-roles.mjs";
import {
  WorkspaceError,
  readWorkspace,
  listWorkspaces,
  listSpaces,
  commitWorkspace,
  membership,
  canManage,
  planSpaces,
} from "./workspaces.mjs";

export const BILLING_STATUSES = ["active", "trialing", "past_due", "comped", "canceled"];
export const OVERRIDE_KEYS = ["spaces", "agents", "add", "recall", "history_days"];
const ADMIN_AUDIT_KEY = "lm:admin:audit";
const MAX_OVERRIDE_VALUE = 100_000_000;
const MAX_EMAIL_LEN = 160;
const MAX_NOTE_LEN = 500;
const MAX_EXT_ID_LEN = 120;

function billingError(code, status, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  return err;
}

function cleanStr(val, maxLen) {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val !== "string") throw billingError("invalid_input", 400, "Expected string value");
  const trimmed = val.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) throw billingError("invalid_input", 400, `Value exceeds ${maxLen} characters`);
  return trimmed;
}

function normalizeOverrides(raw, existing = {}) {
  if (raw === undefined) return existing && typeof existing === "object" ? { ...existing } : {};
  if (raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw billingError("invalid_overrides", 400, "limitOverrides must be an object or null");
  }
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [k, v] of Object.entries(raw)) {
    if (!OVERRIDE_KEYS.includes(k)) {
      throw billingError("invalid_overrides", 400, `Unsupported override key: ${k}`);
    }
    if (v === undefined) {
      delete next[k];
      continue;
    }
    if (v === null || v === "unlimited") {
      next[k] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_OVERRIDE_VALUE) {
      throw billingError("invalid_overrides", 400, `Invalid override value for ${k}`);
    }
    next[k] = n;
  }
  return next;
}

export function getPlanCatalog() {
  const { plans, grace_ratio = 0.1, aliases = {} } = loadPlans();
  return {
    graceRatio: grace_ratio,
    aliases,
    plans: Object.entries(plans).map(([id, p]) => ({
      id,
      name: p.name,
      priceUsdMonth: p.price_usd_month ?? null,
      historyDays: p.history_days ?? null,
      spaces: p.spaces ?? null,
      agents: p.agents ?? null,
      limits: {
        add: p.limits?.add ?? null,
        read: p.limits?.read ?? null,
        recall: p.limits?.recall ?? null,
      },
      overage: p.overage ?? null,
    })),
  };
}

export function effectivePlanForWorkspace(workspace) {
  const rawPlan = typeof workspace?.plan === "string" && workspace.plan ? workspace.plan : "free";
  let base;
  try {
    base = planFor(rawPlan);
  } catch {
    base = planFor("free");
  }
  const overrides = workspace?.limitOverrides && typeof workspace.limitOverrides === "object"
    ? workspace.limitOverrides
    : {};
  const pick = (key, fallback) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;

  const spacesLimit = !workspace?.plan && !Object.prototype.hasOwnProperty.call(overrides, "spaces")
    ? 10
    : pick("spaces", base.spaces ?? null);

  return {
    id: base.id,
    name: base.name,
    priceUsdMonth: base.price_usd_month ?? null,
    graceRatio: base.grace_ratio ?? 0.1,
    historyDays: pick("history_days", base.history_days ?? null),
    spacesLimit,
    agentsLimit: pick("agents", base.agents ?? null),
    limits: {
      add: pick("add", base.limits?.add ?? null),
      read: base.limits?.read ?? null,
      recall: pick("recall", base.limits?.recall ?? null),
    },
    overage: base.overage ?? null,
    legacyAmnesty: !workspace?.plan,
    overrides,
  };
}

function meterMetric(used, limit, graceRatio) {
  if (!Number.isFinite(limit) || limit === null) {
    return { used, limit: null, graceLimit: null, percent: null, state: "unlimited" };
  }
  const graceLimit = Math.floor(limit * (1 + (graceRatio ?? 0.1)));
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : used > 0 ? 100 : 0;
  let state = "ok";
  if (used >= graceLimit) state = "exceeded";
  else if (used >= limit) state = "grace";
  else if (limit > 0 && used / limit >= 0.8) state = "near";
  return { used, limit, graceLimit, percent, state };
}

async function collectWorkspaceUsage(workspace, redis, now = Date.now) {
  const eff = effectivePlanForWorkspace(workspace);
  const activeSpaces = Object.values(workspace.spaces || {}).filter((s) => s && s.status !== "deleted");
  const agentsKey = workspace.tenantId ? `lm:${namespaceFor(workspace.tenantId)}:agents` : null;
  const agentsCount = agentsKey ? Number(await redis("SCARD", agentsKey).catch(() => 0)) || 0 : 0;
  const currentMonth = monthKey(now());
  const used = workspace.tenantId
    ? await meterUsage(redis, workspace.tenantId, currentMonth).catch(() => ({ add: 0, read: 0, recall: 0 }))
    : { add: 0, read: 0, recall: 0 };

  const spacesLimit = eff.spacesLimit === Number.MAX_SAFE_INTEGER ? null : eff.spacesLimit;
  const adds = meterMetric(used.add || 0, eff.limits.add, eff.graceRatio);
  const recalls = meterMetric(used.recall || 0, eff.limits.recall, eff.graceRatio);
  const spacesM = meterMetric(activeSpaces.length, spacesLimit, 0);
  const agentsM = meterMetric(agentsCount, eff.agentsLimit, 0);

  return {
    month: currentMonth,
    spacesUsed: spacesM.used,
    spacesLimit: spacesM.limit,
    spacesState: spacesM.state,
    agentsUsed: agentsM.used,
    agentsLimit: agentsM.limit,
    agentsState: agentsM.state,
    addsUsed: adds.used,
    addsLimit: adds.limit,
    addsGraceLimit: adds.graceLimit,
    addsPercent: adds.percent,
    addsState: adds.state,
    recallsUsed: recalls.used,
    recallsLimit: recalls.limit,
    recallsGraceLimit: recalls.graceLimit,
    recallsPercent: recalls.percent,
    recallsState: recalls.state,
    readsUsed: used.read || 0,
  };
}

async function readAdminAudit(redis, limit = 30) {
  const raw = await redis("ZRANGE", ADMIN_AUDIT_KEY, -limit, -1).catch(() => []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      try {
        return typeof item === "string" ? JSON.parse(item) : item;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

async function appendAdminAudit(redis, entry) {
  await recordAdminAudit(redis, entry).catch(() => {});
}

async function isDeployAdmin(userId, redis) {
  if (!userId) return false;
  try {
    const auth = await requireAdminAuth(userId, redis, { allowedRoles: ["admin", "billing"] });
    return Boolean(auth?.ok);
  } catch {
    return false;
  }
}

export async function getUserBillingOverview({ userId, workspaceId = null, deps = {} } = {}) {
  if (!userId) throw billingError("sign_in_required", 401, "Sign in required");
  const redis = deps.redis || customerRedis(deps.env);
  const now = deps.now || Date.now;

  if (workspaceId === "fleet-admin") {
    return {
      ok: true,
      data: {
        workspace: null,
        plan: null,
        billing: null,
        usage: null,
        catalog: getPlanCatalog(),
        auditHistory: [],
        isDeployAdmin: await isDeployAdmin(userId, redis),
      },
    };
  }

  const workspaces = await listWorkspaces({ userId }, { redis });
  if (!workspaces.length) {
    return {
      ok: true,
      data: {
        workspace: null,
        plan: null,
        billing: null,
        usage: null,
        catalog: getPlanCatalog(),
        auditHistory: [],
        isDeployAdmin: await isDeployAdmin(userId, redis),
      },
    };
  }

  const target = workspaceId ? workspaces.find((w) => w.id === workspaceId) : workspaces[0];
  if (!target) throw new WorkspaceError("not_found", 404);
  const { w } = await readWorkspace(redis, target.id);
  const member = membership(w, userId);
  const canManageBilling = ["owner", "admin"].includes(member.role);
  const eff = effectivePlanForWorkspace(w);
  const usage = await collectWorkspaceUsage(w, redis, now);
  const deployAdmin = await isDeployAdmin(userId, redis);

  const billingAudit = Array.isArray(w.audit)
    ? w.audit
        .filter((e) => e && typeof e.action === "string" && (e.action.includes("billing") || e.action.includes("plan")))
        .slice(-15)
        .reverse()
    : [];

  return {
    ok: true,
    data: {
      workspace: {
        id: w.id,
        name: w.name,
        tenantId: w.tenantId,
        role: member.role,
        canManageBilling,
        isDeployAdmin: deployAdmin,
      },
      plan: eff,
      billing: {
        status: w.billingStatus || "active",
        email: canManageBilling ? w.billingEmail || null : null,
        note: w.billingNote || null,
        externalCustomerId: canManageBilling ? w.externalCustomerId || null : null,
        updatedAt: w.billingUpdatedAt || w.createdAt || null,
      },
      usage,
      catalog: getPlanCatalog(),
      auditHistory: billingAudit,
      isDeployAdmin: deployAdmin,
    },
  };
}

export async function updateUserBillingSettings(
  { userId, workspaceId, action, billingEmail, requestedPlan, note, requestId },
  deps = {}
) {
  if (!userId) throw billingError("sign_in_required", 401, "Sign in required");
  if (!workspaceId) throw billingError("missing_workspace_id", 400, "workspaceId is required");
  const redis = deps.redis || customerRedis(deps.env);
  const now = deps.now || Date.now;
  const ts = now();

  const { w } = await readWorkspace(redis, workspaceId);
  if (!canManage(w, userId)) throw billingError("forbidden", 403, "Owner or admin role required");

  if (action === "update_contact") {
    const email = cleanStr(billingEmail, MAX_EMAIL_LEN);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw billingError("invalid_email", 400, "Enter a valid billing email address");
    }
    const reqId = requestId || `bill-${crypto.randomUUID()}`;
    const event = {
      at: ts,
      actor: userId,
      action: "billing_contact_updated",
      email,
    };
    const committed = await commitWorkspace(
      {
        before: w,
        after: {
          ...w,
          version: (w.version || 1) + 1,
          billingEmail: email,
          billingUpdatedAt: ts,
          billingUpdatedBy: userId,
          audit: [...(w.audit || []), event],
        },
        userId,
        requestId: reqId,
        operation: "billing_contact",
        fingerprint: JSON.stringify({ workspaceId, email }),
        result: { ok: true, billingEmail: email },
      },
      { redis }
    );
    if (!committed) throw billingError("conflict", 409, "Workspace changed; please retry");
    return getUserBillingOverview({ userId, workspaceId, deps: { ...deps, redis, now } });
  }

  if (action === "request_plan") {
    let targetPlan;
    try {
      targetPlan = planFor(requestedPlan);
    } catch {
      throw billingError("unknown_plan", 400, "Unknown plan tier");
    }
    const cleanNote = cleanStr(note, MAX_NOTE_LEN);
    const reqId = requestId || `planreq-${crypto.randomUUID()}`;
    const event = {
      at: ts,
      actor: userId,
      action: "plan_upgrade_requested",
      fromPlan: w.plan || "free",
      toPlan: targetPlan.id,
      note: cleanNote,
    };
    const committed = await commitWorkspace(
      {
        before: w,
        after: {
          ...w,
          version: (w.version || 1) + 1,
          billingUpdatedAt: ts,
          billingUpdatedBy: userId,
          audit: [...(w.audit || []), event],
        },
        userId,
        requestId: reqId,
        operation: "plan_request",
        fingerprint: JSON.stringify({ workspaceId, toPlan: targetPlan.id, note: cleanNote }),
        result: { ok: true, requestedPlan: targetPlan.id },
      },
      { redis }
    );
    if (!committed) throw billingError("conflict", 409, "Workspace changed; please retry");
    await appendAdminAudit(redis, {
      ...event,
      workspaceId: w.id,
      workspaceName: w.name,
      tenantId: w.tenantId,
    });
    return getUserBillingOverview({ userId, workspaceId, deps: { ...deps, redis, now } });
  }

  throw billingError("unknown_action", 400, "Unsupported billing action");
}

async function scanKeys(redis, pattern) {
  const keys = [];
  let cursor = "0";
  for (let i = 0; i < 40; i++) {
    const res = await redis("SCAN", cursor, "MATCH", pattern, "COUNT", "200").catch(() => null);
    if (!Array.isArray(res) || res.length < 2) break;
    cursor = String(res[0] ?? "0");
    if (Array.isArray(res[1])) keys.push(...res[1]);
    if (cursor === "0") break;
  }
  return [...new Set(keys)];
}

export async function resolveAdminBillingActor(req, deps = {}) {
  const redis = deps.redis || customerRedis(deps.env);
  const env = deps.env || process.env;

  // 1. Prefer verified Clerk session + live deploy admin/billing role check
  const getSession = deps.session || ((r, opts) => customerSession(r, opts));
  let session = null;
  try {
    session = await getSession(req, { env });
  } catch {
    session = null;
  }
  if (session?.status === "signed-in" && session.userId) {
    const auth = await requireAdminAuth(session.userId, redis, { allowedRoles: ["admin", "billing"] });
    if (!auth?.ok) {
      throw billingError(auth?.error || "forbidden", auth?.status || 403, auth?.hint || "Admin or billing role required");
    }
    return { actorId: session.userId, role: auth.role, via: "clerk" };
  }

  // 2. Fallback to break-glass lm_admin cookie
  const legacyActor = adminIdentity(req, env);
  if (legacyActor) {
    if (legacyActor === "admin") {
      const r = await activeRole(legacyActor, redis);
      if (r?.role && !["admin", "billing"].includes(r.role)) {
        throw billingError("forbidden", 403, "Admin or billing role required");
      }
      return { actorId: legacyActor, role: r?.role || "admin", via: BREAK_GLASS };
    }
    const auth = await requireAdminAuth(legacyActor, redis, { allowedRoles: ["admin", "billing"] });
    if (!auth?.ok) {
      throw billingError(auth?.error || "forbidden", auth?.status || 403, auth?.hint || "Admin or billing role required");
    }
    return { actorId: legacyActor, role: auth.role, via: "cookie" };
  }

  throw billingError("sign_in_required", 401, "Admin sign-in required");
}

export async function listAdminBillingWorkspaces({
  redis,
  search = "",
  planFilter = "",
  statusFilter = "",
  now = Date.now,
} = {}) {
  const recordKeys = await scanKeys(redis, "lm:workspace:record:*");
  const rawRecords = await Promise.all(
    recordKeys.map((k) => redis("GET", k).catch(() => null))
  );

  const workspaces = [];
  for (const raw of rawRecords) {
    if (!raw || typeof raw !== "string") continue;
    try {
      const w = JSON.parse(raw);
      if (w && w.id && w.status !== "deleted") workspaces.push(w);
    } catch {
      // skip malformed record
    }
  }

  const enriched = await Promise.all(
    workspaces.map(async (w) => {
      const eff = effectivePlanForWorkspace(w);
      const usage = await collectWorkspaceUsage(w, redis, now);
      const owners = Object.entries(w.members || {})
        .filter(([, m]) => m && m.status === "active" && m.role === "owner")
        .map(([uid]) => uid);
      const memberCount = Object.values(w.members || {}).filter((m) => m && m.status === "active").length;
      return {
        workspaceId: w.id,
        name: w.name || w.id,
        tenantId: w.tenantId || null,
        ownerIds: owners,
        memberCount,
        plan: eff.id,
        planName: eff.name,
        priceUsdMonth: eff.priceUsdMonth,
        legacyAmnesty: eff.legacyAmnesty,
        billingStatus: w.billingStatus || "active",
        billingEmail: w.billingEmail || null,
        billingNote: w.billingNote || null,
        externalCustomerId: w.externalCustomerId || null,
        limitOverrides: eff.overrides,
        effectiveLimits: {
          spaces: eff.spacesLimit === Number.MAX_SAFE_INTEGER ? null : eff.spacesLimit,
          agents: eff.agentsLimit,
          add: eff.limits.add,
          recall: eff.limits.recall,
          historyDays: eff.historyDays,
        },
        usage,
        createdAt: w.createdAt || null,
        updatedAt: w.billingUpdatedAt || w.createdAt || null,
      };
    })
  );

  enriched.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

  const q = String(search || "").trim().toLowerCase();
  const pf = String(planFilter || "").trim().toLowerCase();
  const sf = String(statusFilter || "").trim().toLowerCase();

  const filtered = enriched.filter((item) => {
    if (pf && item.plan !== pf) return false;
    if (sf && item.billingStatus !== sf) return false;
    if (!q) return true;
    return (
      item.workspaceId.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      (item.tenantId && item.tenantId.toLowerCase().includes(q)) ||
      (item.billingEmail && item.billingEmail.toLowerCase().includes(q)) ||
      item.ownerIds.some((id) => id.toLowerCase().includes(q))
    );
  });

  const summary = {
    totalWorkspaces: enriched.length,
    freeCount: enriched.filter((w) => w.plan === "free").length,
    paidOrCompedCount: enriched.filter((w) => w.plan !== "free" || w.billingStatus === "comped").length,
    nearOrOverLimitCount: enriched.filter((w) =>
      ["near", "grace", "exceeded"].includes(w.usage.addsState) ||
      ["near", "grace", "exceeded"].includes(w.usage.recallsState) ||
      ["grace", "exceeded"].includes(w.usage.spacesState) ||
      ["grace", "exceeded"].includes(w.usage.agentsState)
    ).length,
  };

  const adminAudit = await readAdminAudit(redis, 40);
  const billingAudit = adminAudit.filter(
    (e) => e && typeof e.action === "string" && (e.action.includes("billing") || e.action.includes("plan"))
  );

  return {
    ok: true,
    data: {
      workspaces: filtered,
      summary,
      catalog: getPlanCatalog(),
      auditHistory: billingAudit,
    },
  };
}

export async function updateAdminWorkspaceBilling(
  {
    workspaceId,
    actorId,
    plan,
    billingStatus,
    billingEmail,
    billingNote,
    externalCustomerId,
    limitOverrides,
    clearOverrides = false,
    requestId,
  },
  deps = {}
) {
  if (!workspaceId) throw billingError("missing_workspace_id", 400, "workspaceId is required");
  if (!actorId) throw billingError("sign_in_required", 401, "Admin identity required");
  const redis = deps.redis || customerRedis(deps.env);
  const now = deps.now || Date.now;
  const ts = now();

  const { w } = await readWorkspace(redis, workspaceId);

  let nextPlan = w.plan || "free";
  if (plan !== undefined && plan !== null && plan !== "") {
    try {
      nextPlan = planFor(plan).id;
    } catch {
      throw billingError("unknown_plan", 400, `Unknown plan: ${plan}`);
    }
  }

  let nextStatus = w.billingStatus || "active";
  if (billingStatus !== undefined && billingStatus !== null && billingStatus !== "") {
    if (!BILLING_STATUSES.includes(billingStatus)) {
      throw billingError("invalid_billing_status", 400, `Invalid billing status: ${billingStatus}`);
    }
    nextStatus = billingStatus;
  }

  const nextEmail = billingEmail !== undefined ? cleanStr(billingEmail, MAX_EMAIL_LEN) : w.billingEmail ?? null;
  if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    throw billingError("invalid_email", 400, "Invalid billing email");
  }
  const nextNote = billingNote !== undefined ? cleanStr(billingNote, MAX_NOTE_LEN) : w.billingNote ?? null;
  const nextExtId =
    externalCustomerId !== undefined ? cleanStr(externalCustomerId, MAX_EXT_ID_LEN) : w.externalCustomerId ?? null;

  const nextOverrides = clearOverrides
    ? {}
    : normalizeOverrides(limitOverrides, w.limitOverrides || {});

  const event = {
    at: ts,
    actor: actorId,
    action: "admin_billing_updated",
    workspaceId: w.id,
    workspaceName: w.name,
    before: {
      plan: w.plan || "free",
      billingStatus: w.billingStatus || "active",
      limitOverrides: w.limitOverrides || {},
    },
    after: {
      plan: nextPlan,
      billingStatus: nextStatus,
      limitOverrides: nextOverrides,
    },
    note: nextNote,
  };

  const reqId = requestId || `admbill-${crypto.randomUUID()}`;
  const committed = await commitWorkspace(
    {
      before: w,
      after: {
        ...w,
        version: (w.version || 1) + 1,
        plan: nextPlan,
        billingStatus: nextStatus,
        billingEmail: nextEmail,
        billingNote: nextNote,
        externalCustomerId: nextExtId,
        limitOverrides: nextOverrides,
        billingUpdatedAt: ts,
        billingUpdatedBy: actorId,
        audit: [...(w.audit || []), event],
      },
      userId: actorId,
      requestId: reqId,
      operation: "admin_billing_update",
      fingerprint: JSON.stringify({
        workspaceId,
        nextPlan,
        nextStatus,
        nextEmail,
        nextNote,
        nextExtId,
        nextOverrides,
      }),
      result: { ok: true, workspaceId, plan: nextPlan, billingStatus: nextStatus },
    },
    { redis }
  );
  if (!committed) throw billingError("conflict", 409, "Workspace changed concurrently; please retry");

  // Keep acmi:cloud:tenant:{tenantId} in sync with workspace plan & overrides
  if (w.tenantId) {
    const tenantKey = `acmi:cloud:tenant:${w.tenantId}`;
    await redis("HSET", tenantKey, "plan", nextPlan, "billing_status", nextStatus).catch(() => {});
    if (Object.keys(nextOverrides).length > 0) {
      await redis("HSET", tenantKey, "limit_overrides", JSON.stringify(nextOverrides)).catch(() => {});
    } else {
      await redis("HDEL", tenantKey, "limit_overrides").catch(() => {});
    }
  }

  await appendAdminAudit(redis, event);

  return {
    ok: true,
    data: {
      workspaceId: w.id,
      plan: nextPlan,
      billingStatus: nextStatus,
      billingEmail: nextEmail,
      billingNote: nextNote,
      externalCustomerId: nextExtId,
      limitOverrides: nextOverrides,
      updatedAt: ts,
    },
  };
}
