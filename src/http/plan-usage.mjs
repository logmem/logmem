// src/http/plan-usage.mjs — Plan and usage rows for the signed-in workspace (Phase 6.2 slice 4).
//
// Every number is read from real sources: cloud/plans.json (Mikey's rulings)
// through planFor, the month counters through meter's pure usage() reader, the
// agent slot set through SCARD, and spaces from the workspace record. Nothing
// is computed as a guess: a missing workspace is an explicit no_workspace
// state, and an unknown plan id is a typed400, never a default silently
// substituted. Rows keep the slice-2 shape: { key, label, value, state? }.
import { planFor, namespaceFor } from "../../cloud/tenants/index.mjs";
import { usage as meterUsage } from "../../cloud/meter/index.mjs";
import { listWorkspaces, readWorkspace } from "./workspaces.mjs";

const row = (key, label, value, state) => ({ key, label, value, ...(state ? { state } : {}) });
const err = (code, status) => Object.assign(new Error(code), { code, status });

export function planRows(plan) {
  return [
    row("plan", "Plan", plan.name),
    row("price", "Price", plan.price_usd_month === 0 ? "Free" : `$${plan.price_usd_month}/mo`),
    row("spaces_limit", "Spaces included", plan.spaces ?? null),
    row("agents_limit", "Agents included", plan.agents ?? null),
    row("history", "History kept", plan.history_days == null ? "All time" : `${plan.history_days} days`),
    row("adds_quota", "Adds per month", plan.limits?.add ?? null),
    row("recalls_quota", "Recalls per month", plan.limits?.recall ?? null),
  ];
}

export async function usageRows({ redis, tenant, plan, workspace, now = Date.now() }) {
  const rows = [];
  const spacesUsed = Object.values(workspace?.spaces || {}).filter((s) => s?.status !== "archived").length;
  rows.push(row("spaces_used", "Spaces in use", spacesUsed, plan.spaces != null && spacesUsed >= plan.spaces ? "at_limit" : undefined));

  const agentsUsed = Number(await redis("SCARD", `lm:${namespaceFor(tenant)}:agents`)) || 0;
  rows.push(row("agents_used", "Agents active", agentsUsed, plan.agents != null && agentsUsed >= plan.agents ? "at_limit" : undefined));

  const m = await meterUsage(redis, tenant, { now });
  rows.push(row("adds_used", "Adds this month", m.add));
  rows.push(row("recalls_used", "Recalls this month", m.recall));
  const addLimit = plan.limits?.add;
  if (typeof addLimit === "number") {
    const grace = addLimit + Math.floor(addLimit * (plan.grace_ratio ?? 0.1) + 1e-9);
    rows.push(row("adds_state", "Adds remaining before write stop", Math.max(0, grace - m.add), m.add >= addLimit ? "in_grace" : undefined));
  }
  rows.push(row("usage_month", "Meter month", m.month));
  return rows;
}

/** Rows for the caller's own workspace. Owner and admin only, matching the
 *  rename bar; a member gets typed forbidden, a person with no workspace gets
 *  the honest empty state. */
export async function planUsageFor({ userId, deps }) {
  const list = await listWorkspaces({ userId }, deps);
  const owned = list.filter((w) => w.role === "owner" || w.role === "admin");
  if (!owned.length) {
    if (list.length) throw err("forbidden", 403);
    return { ok: true, data: { plan: [row("plan", "Plan", null, "no_workspace")], usage: [] } };
  }
  const pick = owned[0];
  const { w } = await readWorkspace(deps.redis, pick.id);
  let plan;
  try {
    plan = planFor({ plan: w.plan || "free" });
  } catch {
    throw err("unknown_plan", 400);
  }
  return { ok: true, data: { plan: planRows(plan), usage: await usageRows({ redis: deps.redis, tenant: w.tenantId, plan, workspace: w }) } };
}
