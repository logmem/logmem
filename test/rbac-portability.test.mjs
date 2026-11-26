import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import {
  createWorkspace,
  authorizeSpace,
  setMembership,
  listWorkspaceAudit,
  WorkspaceError,
} from "../src/http/workspaces.mjs";
import { createHandler } from "../api/space-io.mjs";

const owner = "user_owner00000001";
const admin = "user_admin00000001";
const editorApprover = "user_edapp00000001";
const editor = "user_edito00000001";
const viewer = "user_viewe00000001";
const ORIGIN = "http://t.local";

function makeCall(redis, userId) {
  const h = createHandler({
    env: { LOGMEM_CUSTOMER_DASHBOARD: "1" },
    redis,
    session: async () => ({ status: "signed-in", userId }),
  });
  return async (body) => {
    const res = {
      _h: {},
      setHeader(k, v) { this._h[k] = v; },
      status(c) { this.c = c; return this; },
      json(j) { this.body = j; return this; },
    };
    await h({
      method: "POST",
      url: `${ORIGIN}/api/space-io`,
      headers: { origin: ORIGIN, "x-logmem-intent": "space-io" },
      body,
    }, res);
    return res;
  };
}

async function setupWorkspace() {
  const redis = createMemoryRedis();
  const { workspace, space } = await createWorkspace(
    { userId: owner, name: "Agency", firstSpaceName: "Client Alpha", requestId: "req-rbac-1" },
    { redis }
  );
  await setMembership({
    actorId: owner, workspaceId: workspace.id, userId: admin, role: "admin",
    spaces: { [space.id]: { role: "editor", canApprove: false } }, requestId: "req-rbac-2",
  }, { redis });
  await setMembership({
    actorId: owner, workspaceId: workspace.id, userId: editorApprover, role: "member",
    spaces: { [space.id]: { role: "editor", canApprove: true } }, requestId: "req-rbac-3",
  }, { redis });
  await setMembership({
    actorId: owner, workspaceId: workspace.id, userId: editor, role: "member",
    spaces: { [space.id]: { role: "editor", canApprove: false } }, requestId: "req-rbac-4",
  }, { redis });
  await setMembership({
    actorId: owner, workspaceId: workspace.id, userId: viewer, role: "viewer",
    spaces: { [space.id]: { role: "viewer", canApprove: false } }, requestId: "req-rbac-5",
  }, { redis });

  await redis("SADD", `lm:${space.namespace}:agent:list`, "quill");
  await redis("SET", `lm:${space.namespace}:agent:quill:who`, JSON.stringify({ name: "Quill", role: "Writer" }));
  await redis("SADD", `lm:${space.namespace}:plan:list`, "launch");
  await redis("SET", `lm:${space.namespace}:plan:launch`, JSON.stringify({ id: "launch", title: "Launch Plan" }));
  return { redis, wsId: workspace.id, spId: space.id, ns: space.namespace };
}

test("RBAC matrix: export-space, import-space, share-snapshot, transfer-space", async () => {
  const { redis, wsId, spId } = await setupWorkspace();

  // Owner: all 4 allowed
  for (const action of ["export-space", "import-space", "share-snapshot", "transfer-space"]) {
    const ctx = await authorizeSpace({ userId: owner, workspaceId: wsId, spaceId: spId, action }, { redis });
    assert.equal(ctx.permissions.exportSpace, true);
    assert.equal(ctx.permissions.importSpace, true);
    assert.equal(ctx.permissions.shareSnapshot, true);
    assert.equal(ctx.permissions.transferSpace, true);
  }

  // Admin: export, import, share allowed; transfer-space forbidden
  for (const action of ["export-space", "import-space", "share-snapshot"]) {
    const ctx = await authorizeSpace({ userId: admin, workspaceId: wsId, spaceId: spId, action }, { redis });
    assert.equal(ctx.permissions.exportSpace, true);
    assert.equal(ctx.permissions.transferSpace, false);
  }
  await assert.rejects(
    () => authorizeSpace({ userId: admin, workspaceId: wsId, spaceId: spId, action: "transfer-space" }, { redis }),
    (e) => e instanceof WorkspaceError && e.status === 403
  );

  // Editor+Approver, Editor, Viewer: all 4 portability actions forbidden
  for (const uid of [editorApprover, editor, viewer]) {
    for (const action of ["export-space", "import-space", "share-snapshot", "transfer-space"]) {
      await assert.rejects(
        () => authorizeSpace({ userId: uid, workspaceId: wsId, spaceId: spId, action }, { redis }),
        (e) => e instanceof WorkspaceError && e.status === 403
      );
    }
  }
});

test("space-io v2: owner exports gzip base64, imports into new space, records audit trail, and blocks viewers", async () => {
  const { redis, wsId, spId } = await setupWorkspace();
  const asOwner = makeCall(redis, owner);
  const asViewer = makeCall(redis, viewer);
  const asEditor = makeCall(redis, editor);

  // Viewer and Editor blocked from export
  assert.equal((await asViewer({ action: "export-space", workspaceId: wsId, spaceId: spId })).c, 403);
  assert.equal((await asEditor({ action: "export-space", workspaceId: wsId, spaceId: spId })).c, 403);

  // Owner exports v2 gzipped blueprint
  const exp = await asOwner({
    action: "export-space",
    workspaceId: wsId,
    spaceId: spId,
    version: 2,
    mode: "blueprint",
    gzip: true,
    dryRun: false,
    approved: true,
  });
  assert.equal(exp.c, 200);
  assert.equal(exp.body.mode, "blueprint");
  assert.equal(typeof exp.body.bufferBase64, "string");
  assert.equal(exp.body.manifest.agents, 1);

  // Preview import into new space (no spaceId)
  const plan = await asOwner({
    action: "import-plan",
    workspaceId: wsId,
    bundle: exp.body.bufferBase64,
    bundleEncoding: "gzip-base64",
  });
  assert.equal(plan.c, 200);
  assert.equal(plan.body.manifest.agents, 1);
  assert.equal(plan.body.quota.hasQuota, true);

  // Create new space from bundle
  const created = await asOwner({
    action: "import-create-space",
    workspaceId: wsId,
    name: "Client Alpha Copy",
    bundle: exp.body.bufferBase64,
    bundleEncoding: "gzip-base64",
    checksum: plan.body.checksum,
    approved: true,
  });
  assert.equal(created.c, 200);
  assert.equal(created.body.spaceRecord.name, "Client Alpha Copy");
  assert.ok(created.body.written.created >= 4);

  // Audit history recorded both export and import
  const audit = await listWorkspaceAudit(redis, wsId, { kinds: ["space-exported", "space-imported"] });
  assert.ok(audit.some((a) => a.kind === "space-exported" && a.spaceId === spId));
  assert.ok(audit.some((a) => a.kind === "space-imported" && a.spaceId === created.body.spaceRecord.id));
});
