import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { createWorkspace, listSpaces, accessPolicy, createSpace, setMembership, readWorkspace } from '../src/http/workspaces.mjs';
import { createInvitation, acceptInvitation } from '../src/http/workspace-invites.mjs';

const owner = 'user_owner00000001';
const guest = 'user_suzanne000001';
async function setup() {
  let clock = 1000000;
  const redis = createMemoryRedis();
  const deps = { redis, now: () => clock };
  const a = await createWorkspace({ userId: owner, name: 'Business', firstSpaceName: 'Ops', requestId: 'create-001' }, deps);
  return { ...a, deps };
}
async function inviteContributor(w, s, deps) {
  const invite = await createInvitation({
    actorId: owner, workspaceId: w.id, email: 'suzanne@example.com', role: 'contributor',
    spaces: { [s.id]: { role: 'editor', canApprove: false } }, requestId: 'invite-ctb-001',
  }, deps);
  await acceptInvitation({ userId: guest, verifiedEmail: 'suzanne@example.com', token: invite.token }, deps);
  return invite;
}

test('contributor: invite, accept and space visibility work', async () => {
  const { workspace: w, space: s, deps } = await setup();
  await inviteContributor(w, s, deps);
  const spaces = await listSpaces({ userId: guest, workspaceId: w.id }, deps);
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].id, s.id);
});

test('contributor: capability matrix matches Michael requirement', async () => {
  const { workspace: w, space: s, deps } = await setup();
  await inviteContributor(w, s, deps);
  const { w: fresh } = await readWorkspace(deps.redis, w.id);
  const p = accessPolicy(fresh, guest, s.id, 'read');
  assert.equal(p.permissions.read, true, 'reads the space');
  assert.equal(p.permissions.write, true, 'adds and edits entries, comments');
  assert.equal(p.permissions.approve, false, 'cannot approve by default');
  assert.equal(p.permissions.manage, false, 'cannot manage members or connections');
  for (const forbidden of ['manage-members', 'manage-connections', 'create-space']) {
    assert.throws(() => accessPolicy(fresh, guest, s.id, forbidden), (e) => e.status === 403, forbidden);
  }
});

test('contributor: without a space grant the space is not visible', async () => {
  const { workspace: w, space: s, deps } = await setup();
  const invite = await createInvitation({
    actorId: owner, workspaceId: w.id, email: 'nogrant@example.com', role: 'contributor',
    spaces: { [s.id]: { role: 'viewer', canApprove: false } }, requestId: 'invite-ctb-002',
  }, deps);
  // accepted contributor whose grant record was never added for another space
  await acceptInvitation({ userId: guest, verifiedEmail: 'nogrant@example.com', token: invite.token }, deps);
  const otherSpaceId = 's-unknown0000000000000';
  const { w: fresh } = await readWorkspace(deps.redis, w.id);
  assert.throws(() => accessPolicy(fresh, guest, otherSpaceId, 'read'), (e) => e.status === 404);
});

test('contributor: cannot create spaces in the shared workspace', async () => {
  const { workspace: w, deps } = await setup();
  await inviteContributor(w, Object.values(w.spaces)[0], deps);
  await assert.rejects(createSpace({ userId: guest, workspaceId: w.id, name: 'Sneaky', requestId: 'space-ctb-001' }, deps), { status: 403 });
});

test('contributor: cannot assign or remove other members', async () => {
  const { workspace: w, space: s, deps } = await setup();
  await inviteContributor(w, s, deps);
  await assert.rejects(setMembership({ actorId: guest, workspaceId: w.id, userId: owner, role: 'viewer', requestId: 'set-ctb-001' }, deps), { status: 403 });
});

test('owner: setMembership accepts the contributor role', async () => {
  const { workspace: w, space: s, deps } = await setup();
  const r = await setMembership({
    actorId: owner, workspaceId: w.id, userId: 'user_third000000001', role: 'contributor',
    spaces: { [s.id]: { role: 'editor', canApprove: false } }, requestId: 'set-ctb-002',
  }, deps);
  assert.ok(r);
  const fresh = (await listSpaces({ userId: 'user_third000000001', workspaceId: w.id }, deps));
  assert.equal(fresh.length, 1, 'contributor sees the granted space');
});
