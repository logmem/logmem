import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import {
  createWorkspace,
  createSpace,
  setMembership,
  removeMembership,
  listWorkspaces,
  listSpaces
} from '../src/http/workspaces.mjs';
import {
  resolveDashboardViewer,
  listViewerWorkspaces
} from '../apps/dashboard/lib/server/viewer.mjs';

const ALICE_ID = 'user_alice0000000001';
const BOB_ID = 'user_bob00000000002';

async function setupFleet() {
  const redis = createMemoryRedis();

  // 1. Alice creates Workspace A with Ops space and Secret space
  const aliceWs = await createWorkspace(
    { userId: ALICE_ID, name: 'Alice Corp', firstSpaceName: 'Ops', requestId: 'req-alice-01' },
    { redis }
  );
  const aliceSecret = await createSpace(
    { userId: ALICE_ID, workspaceId: aliceWs.workspace.id, name: 'Secret', requestId: 'req-alice-02' },
    { redis }
  );

  // 2. Bob creates Workspace B with Engineering space
  const bobWs = await createWorkspace(
    { userId: BOB_ID, name: 'Bob Tech', firstSpaceName: 'Engineering', requestId: 'req-bob-01' },
    { redis }
  );

  return {
    redis,
    alice: {
      userId: ALICE_ID,
      workspace: aliceWs.workspace,
      opsSpace: aliceWs.space,
      secretSpace: aliceSecret.space
    },
    bob: {
      userId: BOB_ID,
      workspace: bobWs.workspace,
      engSpace: bobWs.space
    }
  };
}

test('two-identity: direct foreign workspace or space URLs throw 404 without leaking records', async () => {
  const { redis, alice, bob } = await setupFleet();

  // Alice tries to access Bob's workspace and space
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: bob.workspace.id, spaceId: bob.engSpace.id, action: 'read' },
      { redis, session: async () => ({ status: 'signed-in', userId: alice.userId }) }
    ),
    { status: 404 }
  );

  // Bob tries to access Alice's workspace and Ops space
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id, action: 'read' },
      { redis, session: async () => ({ status: 'signed-in', userId: bob.userId }) }
    ),
    { status: 404 }
  );

  // Bob tries to access Alice's Secret space directly
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: alice.workspace.id, spaceId: alice.secretSpace.id, action: 'read' },
      { redis, session: async () => ({ status: 'signed-in', userId: bob.userId }) }
    ),
    { status: 404 }
  );
});

test('two-identity: sibling space isolation refuses access to ungranted spaces in the same workspace', async () => {
  const { redis, alice, bob } = await setupFleet();

  // Alice invites Bob to Workspace A, granting access ONLY to Ops space (editor)
  await setMembership(
    {
      actorId: alice.userId,
      workspaceId: alice.workspace.id,
      userId: bob.userId,
      role: 'member',
      spaces: { [alice.opsSpace.id]: { role: 'editor', canApprove: false } },
      requestId: 'grant-bob-ops'
    },
    { redis }
  );

  // Bob can access Ops space in Workspace A
  const bobOps = await resolveDashboardViewer(
    { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id, action: 'write' },
    { redis, session: async () => ({ status: 'signed-in', userId: bob.userId }) }
  );
  assert.equal(bobOps.person, `human:${bob.userId}`);
  assert.equal(bobOps.permissions.canWrite, true);
  assert.equal(bobOps.permissions.canApprove, false);

  // Bob tries to access sibling Secret space in Workspace A -> refused (404)
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: alice.workspace.id, spaceId: alice.secretSpace.id, action: 'read' },
      { redis, session: async () => ({ status: 'signed-in', userId: bob.userId }) }
    ),
    { status: 404 }
  );

  // Bob's Ops runner cannot write to Secret space namespace
  await assert.rejects(
    bobOps.redis('SET', `lm:${alice.secretSpace.namespace}:leak`, 'payload'),
    { status: 403 }
  );
  assert.equal(await redis('GET', `lm:${alice.secretSpace.namespace}:leak`), null);
});

test('two-identity: strict rejection of caller-supplied Redis credentials or tenant overrides', async () => {
  const { redis, alice } = await setupFleet();
  const session = async () => ({ status: 'signed-in', userId: alice.userId });

  // Caller attempts to inject custom redis credential or connection URL
  for (const field of ['redis', 'redisUri', 'callerRedis', 'redisCredential', 'tenantId', 'namespace']) {
    await assert.rejects(
      resolveDashboardViewer(
        {
          workspaceId: alice.workspace.id,
          spaceId: alice.opsSpace.id,
          action: 'read',
          [field]: 'malicious-override'
        },
        { redis, session }
      ),
      { status: 403 }
    );
  }
});

test('two-identity: in-flight revocation rejects delayed writes and revalidate fails', async () => {
  const { redis, alice, bob } = await setupFleet();

  // Grant Bob editor on Ops
  await setMembership(
    {
      actorId: alice.userId,
      workspaceId: alice.workspace.id,
      userId: bob.userId,
      role: 'member',
      spaces: { [alice.opsSpace.id]: { role: 'editor', canApprove: false } },
      requestId: 'grant-bob-ops-2'
    },
    { redis }
  );

  // Bob resolves viewer for Ops
  const bobViewer = await resolveDashboardViewer(
    { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id, action: 'write' },
    { redis, session: async () => ({ status: 'signed-in', userId: bob.userId }) }
  );

  // Alice revokes Bob before his delayed write arrives
  await removeMembership(
    { actorId: alice.userId, workspaceId: alice.workspace.id, userId: bob.userId, requestId: 'revoke-bob' },
    { redis }
  );

  // Bob's in-flight runner write must fail with 404
  await assert.rejects(
    bobViewer.redis('SET', `lm:${alice.opsSpace.namespace}:delayed`, 'data'),
    { status: 404 }
  );
  assert.equal(await redis('GET', `lm:${alice.opsSpace.namespace}:delayed`), null);

  // Bob revalidate must fail with 404
  await assert.rejects(bobViewer.revalidate(), { status: 404 });
});

test('two-identity: delayed response between space switching stays quarantined to source namespace', async () => {
  const { redis, alice } = await setupFleet();
  const session = async () => ({ status: 'signed-in', userId: alice.userId });

  // Alice resolves Ops space
  const opsViewer = await resolveDashboardViewer(
    { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id, action: 'write' },
    { redis, session }
  );

  // Alice resolves Secret space
  const secretViewer = await resolveDashboardViewer(
    { workspaceId: alice.workspace.id, spaceId: alice.secretSpace.id, action: 'write' },
    { redis, session }
  );

  // A delayed write originating from Ops context writes only to Ops namespace
  await opsViewer.redis('SET', `lm:${alice.opsSpace.namespace}:item`, 'ops-val');
  assert.equal(await opsViewer.redis('GET', `lm:${alice.opsSpace.namespace}:item`), 'ops-val');

  // Ops runner cannot touch Secret namespace
  await assert.rejects(
    opsViewer.redis('SET', `lm:${alice.secretSpace.namespace}:item`, 'cross-val'),
    { status: 403 }
  );
  assert.equal(await redis('GET', `lm:${alice.secretSpace.namespace}:item`), null);

  // Secret runner writes to Secret namespace
  await secretViewer.redis('SET', `lm:${alice.secretSpace.namespace}:item`, 'secret-val');
  assert.equal(await secretViewer.redis('GET', `lm:${alice.secretSpace.namespace}:item`), 'secret-val');
});

test('two-identity: anonymous callers and invalid inputs fail with uniform status codes', async () => {
  const { redis, alice } = await setupFleet();

  // Signed out caller returns 401
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id },
      { redis, session: async () => ({ status: 'signed-out' }) }
    ),
    { status: 401 }
  );

  // Missing IDs return 400
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: '', spaceId: alice.opsSpace.id },
      { redis, session: async () => ({ status: 'signed-in', userId: alice.userId }) }
    ),
    { status: 400 }
  );

  // Invalid action returns 400
  await assert.rejects(
    resolveDashboardViewer(
      { workspaceId: alice.workspace.id, spaceId: alice.opsSpace.id, action: 'superadmin' },
      { redis, session: async () => ({ status: 'signed-in', userId: alice.userId }) }
    ),
    { status: 400 }
  );

  // Authorized listing lists only Alice's workspaces and spaces
  const aliceList = await listViewerWorkspaces(alice.userId, { redis });
  assert.equal(aliceList.length, 1);
  assert.equal(aliceList[0].id, alice.workspace.id);
  assert.equal(aliceList[0].spaces.length, 2);
});
