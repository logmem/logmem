import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace, createSpace, readWorkspace } from "../src/http/workspaces.mjs";
import { meter } from "../cloud/meter/index.mjs";
import { namespaceFor } from "../cloud/tenants/index.mjs";
import {
  getUserBillingOverview,
  updateUserBillingSettings,
  listAdminBillingWorkspaces,
  updateAdminWorkspaceBilling,
} from "../src/http/billing-plans.mjs";
import { createHandler as createBillingHandler } from "../api/billing.mjs";
import { setRole } from "../src/http/admin-roles.mjs";
import { createHandler as createAdminBillingHandler } from "../api/admin-billing.mjs";

const OWNER = "user_owner000000001";
const MEMBER = "user_member00000001";
const BILLING_ADMIN = "user_billadm0000001";
const VIEWER_ADMIN = "user_viewadm0000001";
const STRANGER = "user_stranger000001";

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(j) { this.body = j; return this; },
  };
}

async function setupFixture() {
  const redis = createMemoryRedis();
  const { workspace } = await createWorkspace(
    { userId: OWNER, name: "Acme", firstSpaceName: "Main", requestId: "req-billing-001", plan: "free" },
    { redis }
  );
  // Add a regular member
  const wKey = `lm:workspace:record:${workspace.id}`;
  const w = JSON.parse(await redis("GET", wKey));
  w.members[MEMBER] = { role: "member", status: "active", spaces: {} };
  await redis("SET", wKey, JSON.stringify(w));
  await redis("SADD", `lm:workspace:user:${MEMBER}`, workspace.id);

  // Grant deploy billing role to BILLING_ADMIN and viewer role to VIEWER_ADMIN
  await setRole({ actorId: "break-glass", userId: BILLING_ADMIN, role: "billing", redis });
  await setRole({ actorId: "break-glass", userId: VIEWER_ADMIN, role: "viewer", redis });

  await meter(redis, workspace.tenantId, "add", 12, { plan: { limits: { add: 1000 }, grace_ratio: 0.1 } });
  await redis("SADD", `lm:${namespaceFor(workspace.tenantId)}:agents`, "agent-a");

  return { redis, workspace };
}

test("user view: owner sees full billing & usage, member sees read-only without email", async () => {
  const { redis, workspace } = await setupFixture();

  const ownerRes = await getUserBillingOverview({ userId: OWNER, workspaceId: workspace.id, deps: { redis } });
  assert.equal(ownerRes.ok, true);
  assert.equal(ownerRes.data.plan.id, "free");
  assert.equal(ownerRes.data.usage.addsUsed, 12);
  assert.equal(ownerRes.data.usage.agentsUsed, 1);
  assert.equal(ownerRes.data.workspace.canManageBilling, true);
  assert.equal(ownerRes.data.isDeployAdmin, false);

  // Update contact email as owner
  const updated = await updateUserBillingSettings(
    { userId: OWNER, workspaceId: workspace.id, action: "update_contact", billingEmail: "pay@acme.io" },
    { redis }
  );
  assert.equal(updated.data.billing.email, "pay@acme.io");

  // Regular member cannot see billing email or mutate
  const memberRes = await getUserBillingOverview({ userId: MEMBER, workspaceId: workspace.id, deps: { redis } });
  assert.equal(memberRes.data.workspace.canManageBilling, false);
  assert.equal(memberRes.data.billing.email, null);

  // Fleet-admin virtual workspace returns clean empty workspace state without throwing 404
  const fleetRes = await getUserBillingOverview({ userId: BILLING_ADMIN, workspaceId: "fleet-admin", deps: { redis } });
  assert.equal(fleetRes.ok, true);
  assert.equal(fleetRes.data.workspace, null);
  assert.equal(fleetRes.data.isDeployAdmin, true);

  await assert.rejects(
    updateUserBillingSettings(
      { userId: MEMBER, workspaceId: workspace.id, action: "update_contact", billingEmail: "x@acme.io" },
      { redis }
    ),
    (e) => e.status === 403 && e.code === "forbidden"
  );
});

test("admin view: RBAC enforces admin/billing role, updates plan + tenant hash + limitOverrides + audit", async () => {
  const { redis, workspace } = await setupFixture();

  const adminHandler = createAdminBillingHandler({
    env: { LOGMEM_CUSTOMER_DASHBOARD: "1" },
    redis: () => redis,
    session: async (req) => ({ status: "signed-in", userId: req.headers["x-test-user"] }),
  });

  // Non-admin and viewer-role admin are denied
  for (const uid of [STRANGER, VIEWER_ADMIN]) {
    const res = mockRes();
    await adminHandler({ method: "GET", url: "/api/admin-billing", headers: { "x-test-user": uid } }, res);
    assert.equal(res.statusCode, 403);
  }

  // Billing admin can list workspaces
  const listRes = mockRes();
  await adminHandler({ method: "GET", url: "/api/admin-billing", headers: { "x-test-user": BILLING_ADMIN } }, listRes);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.body.ok, true);
  assert.equal(listRes.body.data.workspaces.length, 1);
  assert.equal(listRes.body.data.workspaces[0].plan, "free");

  // Missing intent header is rejected
  const noIntent = mockRes();
  await adminHandler(
    {
      method: "POST",
      url: "/api/admin-billing",
      headers: { "x-test-user": BILLING_ADMIN, origin: "https://logmem.si", host: "logmem.si" },
      body: { workspaceId: workspace.id, plan: "pro" },
    },
    noIntent
  );
  assert.equal(noIntent.statusCode, 403);

  // Valid admin update sets Pro + comped + custom spaces override (5)
  const postRes = mockRes();
  await adminHandler(
    {
      method: "POST",
      url: "/api/admin-billing",
      headers: {
        "x-test-user": BILLING_ADMIN,
        "x-logmem-intent": "admin-billing",
        origin: "https://logmem.si",
        host: "logmem.si",
      },
      body: {
        workspaceId: workspace.id,
        plan: "pro",
        billingStatus: "comped",
        billingNote: "Founder comp",
        limitOverrides: { spaces: 5, agents: null },
      },
    },
    postRes
  );
  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.data.plan, "pro");
  assert.equal(postRes.body.data.billingStatus, "comped");

  // Verify tenant hash is synced
  assert.equal(await redis("HGET", `acmi:cloud:tenant:${workspace.tenantId}`, "plan"), "pro");
  assert.equal(await redis("HGET", `acmi:cloud:tenant:${workspace.tenantId}`, "billing_status"), "comped");

  // Verify custom spaces override (5) allows creating 4 more spaces (Pro default is 3)
  for (let i = 2; i <= 5; i++) {
    await createSpace({ userId: OWNER, workspaceId: workspace.id, name: `Space ${i}`, requestId: `space-create-00${i}` }, { redis });
  }
  await assert.rejects(
    createSpace({ userId: OWNER, workspaceId: workspace.id, name: "Space 6", requestId: "space-create-006" }, { redis }),
    (e) => e.code === "space_limit"
  );

  // Verify audit trail in workspace + admin audit
  const { w: afterW } = await readWorkspace(redis, workspace.id);
  assert.ok(afterW.audit.some((e) => e.action === "admin_billing_updated" && e.after.plan === "pro"));
  const adminAudit = await redis("ZRANGE", "lm:admin:audit", -5, -1);
  assert.ok(adminAudit.some((raw) => raw.includes("admin_billing_updated")));
});

test("user api/billing handler enforces auth and owner/admin writes", async () => {
  const { redis, workspace } = await setupFixture();
  const handler = createBillingHandler({
    env: { LOGMEM_CUSTOMER_DASHBOARD: "1" },
    redis,
    session: async (req) =>
      req.headers["x-test-user"]
        ? { status: "signed-in", userId: req.headers["x-test-user"] }
        : { status: "signed-out" },
  });

  const unauth = mockRes();
  await handler({ method: "GET", url: "/api/billing", headers: {} }, unauth);
  assert.equal(unauth.statusCode, 401);

  const ok = mockRes();
  await handler({ method: "GET", url: "/api/billing", headers: { "x-test-user": OWNER } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data.plan.id, "free");

  const reqUpgrade = mockRes();
  await handler(
    {
      method: "POST",
      url: "/api/billing",
      headers: { "x-test-user": OWNER },
      body: { workspaceId: workspace.id, action: "request_plan", requestedPlan: "pro" },
    },
    reqUpgrade
  );
  assert.equal(reqUpgrade.statusCode, 200);
});

test("UI parity and dashboard guardrails: no raw hex or /app links", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const files = [
    "apps/dashboard/app/(workspace)/space/[space]/components/billing-tab.tsx",
    "apps/dashboard/app/(workspace)/admin/billing/page.tsx",
    "apps/dashboard/app/(workspace)/admin/billing/admin-billing-view.tsx",
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(text), false, `raw hex found in ${rel}`);
    assert.equal(/href=["'`]\/app/.test(text), false, `/app link found in ${rel}`);
  }
  const vanilla = fs.readFileSync(path.join(root, "public/app/billing-view.js"), "utf8");
  assert.ok(vanilla.includes("billingPanel") && vanilla.includes("showAdminBilling"));
});
