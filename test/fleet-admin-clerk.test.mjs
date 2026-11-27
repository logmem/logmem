import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { setRole, suspendUser } from "../src/http/admin-roles.mjs";
import { WorkspaceError } from "../src/http/workspaces.mjs";
import {
  FLEET_WORKSPACE_ID,
  fleetSpaces,
  listFleetAdminWorkspace,
  resolveFleetAdminAccess,
} from "../src/http/fleet-admin.mjs";
import { resolveViewer } from "../src/http/viewer.mjs";
import { resolveDashboardViewer, listViewerWorkspaces } from "../apps/dashboard/lib/server/viewer.mjs";

const adminUser = "user_adminclerk0001";
const regularUser = "user_regular0000001";
const fleetEnv = {
  LOGMEM_CUSTOMER_DASHBOARD: "1",
  LOGMEM_REST_URL: "https://fleet.example.upstash.io",
  LOGMEM_REST_TOKEN: "token-123",
  LOGMEM_VIEW_SPACES: "madez,fieldnotes",
  LOGMEM_ADMIN_ID: "mikey",
};

test("fleet-admin: non-admin Clerk user never sees fleet workspace and is refused on resolve", async () => {
  const customerRedis = createMemoryRedis();
  const fleetRedis = createMemoryRedis();

  assert.equal(await listFleetAdminWorkspace(regularUser, { redis: customerRedis, env: fleetEnv }), null);
  await assert.rejects(
    () =>
      resolveFleetAdminAccess(
        { userId: regularUser, spaceId: "madez", action: "read" },
        { redis: customerRedis, env: fleetEnv, fleetRedis },
      ),
    (e) => e instanceof WorkspaceError && e.status === 403,
  );
});

test("fleet-admin: Clerk deploy admin sees madez, resolves Fleet Redis with human:mikey, and respects suspension", async () => {
  const customerRedis = createMemoryRedis();
  const fleetRedis = createMemoryRedis();
  await fleetRedis("SET", "lm:madez:agent:quill:who", JSON.stringify({ name: "Quill" }));

  await setRole({ actorId: "break-glass", userId: adminUser, role: "admin", redis: customerRedis });

  // 1. Both listViewerWorkspaces (Next.js) and listFleetAdminWorkspace mount Fleet (Admin)
  const wsList = await listViewerWorkspaces(adminUser, { redis: customerRedis, env: fleetEnv });
  const fleet = wsList.find((w) => w.id === FLEET_WORKSPACE_ID);
  assert.ok(fleet, "admin sees Fleet (Admin) workspace");
  assert.deepEqual(fleet.spaces.map((s) => s.id), ["madez", "fieldnotes"]);

  // 2. Dashboard viewer resolves madez against Fleet Redis (read-only for 'read', writable for 'write'/'approve')
  const dashRead = await resolveDashboardViewer(
    { workspaceId: FLEET_WORKSPACE_ID, spaceId: "madez", action: "read" },
    { redis: customerRedis, fleetRedis, env: fleetEnv, session: async () => ({ status: "signed-in", userId: adminUser }) },
  );
  assert.equal(dashRead.person, "human:mikey");
  assert.equal(dashRead.namespace, "madez");
  assert.equal(dashRead.permissions.canApprove, true);
  assert.equal(dashRead.permissions.canExport, true);
  assert.equal(JSON.parse(await dashRead.redis("GET", "lm:madez:agent:quill:who")).name, "Quill");

  // 3. Vanilla resolveViewer resolves madez against Fleet Redis too
  const vanWrite = await resolveViewer(
    { headers: { host: "logmem.si" } },
    { workspaceId: FLEET_WORKSPACE_ID, spaceId: "madez", action: "write" },
    { redis: customerRedis, fleetRedis, env: fleetEnv, session: async () => ({ status: "signed-in", userId: adminUser }) },
  );
  assert.equal(vanWrite.person, "human:mikey");
  await vanWrite.redis("SET", "lm:madez:test:key", "ok");
  assert.equal(await fleetRedis("GET", "lm:madez:test:key"), "ok");

  // 4. Unknown space or unsupported action is refused
  await assert.rejects(
    () =>
      resolveFleetAdminAccess(
        { userId: adminUser, spaceId: "other-space", action: "read" },
        { redis: customerRedis, env: fleetEnv, fleetRedis },
      ),
    (e) => e instanceof WorkspaceError && e.status === 404,
  );
  await assert.rejects(
    () =>
      resolveFleetAdminAccess(
        { userId: adminUser, spaceId: "madez", action: "manage-members" },
        { redis: customerRedis, env: fleetEnv, fleetRedis },
      ),
    (e) => e instanceof WorkspaceError && e.status === 403,
  );

  // 5. Suspending the Clerk admin immediately revokes access
  await suspendUser({ actorId: "break-glass", userId: adminUser, reason: "test", redis: customerRedis });
  await assert.rejects(
    () =>
      resolveFleetAdminAccess(
        { userId: adminUser, spaceId: "madez", action: "read" },
        { redis: customerRedis, env: fleetEnv, fleetRedis },
      ),
    (e) => e instanceof WorkspaceError && e.status === 403,
  );
});

test("fleet-admin: fleetSpaces returns empty when no Fleet backend is configured", () => {
  assert.deepEqual(fleetSpaces({ LOGMEM_VIEW_SPACES: "madez" }), []);
});
