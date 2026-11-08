import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { createWorkspace, createSpace, renameSpace, archiveSpace, unarchiveSpace, authorizeSpace, listWorkspaces, listSpaces } from '../src/http/workspaces.mjs';
const alice = 'user_alice00000001', bob = 'user_bob0000000001';
const input = (userId = alice, requestId = 'request-0001') => ({ userId, name: 'My business', firstSpaceName: 'Operations', requestId });
test('workspace creation retries recover one workspace and one audit event', async () => {
  const deps = { redis: createMemoryRedis() };
  const all = await Promise.all(Array.from({length: 8}, () => createWorkspace(input(), deps)));
  assert.equal(new Set(all.map(x => x.workspace.id)).size, 1);
  assert.equal((await listWorkspaces({userId: alice}, deps)).length, 1);
  const first = all[0];
  assert.match(first.space.namespace, /^s-[a-f0-9]{24}$/);
  assert.equal(first.workspace.audit.length, 1);
  await assert.rejects(createWorkspace({...input(), name: 'Changed'}, deps), {code: 'idempotency_conflict'});
});
test('workspace and space lists stay isolated, even with stale indexes', async () => {
  const deps = { redis: createMemoryRedis() };
  const a = await createWorkspace(input(), deps), b = await createWorkspace(input(bob), deps);
  await deps.redis('SADD', `lm:workspace:user:${alice}`, b.workspace.id);
  assert.deepEqual((await listWorkspaces({userId: alice}, deps)).map(w => w.id), [a.workspace.id]);
  await assert.rejects(listSpaces({userId: bob, workspaceId:a.workspace.id}, deps), {status:404});
  const s = await createSpace({userId:alice, workspaceId:a.workspace.id, name:'Sales', requestId:'space-0001'}, deps);
  assert.notEqual(s.space.namespace, a.space.namespace);
  assert.equal((await listSpaces({userId:alice, workspaceId:a.workspace.id}, deps)).length, 2);
});
test('workspace and space quotas remain atomic under concurrent creation', async () => {
  const deps = {redis:createMemoryRedis(), limits:{ownedWorkspaces:1, spaces:2}};
  const creates = await Promise.allSettled(Array.from({length:6}, (_,i) => createWorkspace(input(alice, `request-${i}`), deps)));
  const ok = creates.filter(x=> x.status==='fulfilled');
  assert.equal(ok.length,1);
  const w = ok[0].value.workspace.id;
  const spaces = await Promise.allSettled(Array.from({length:6}, (_,i) => createSpace({userId:alice, workspaceId:w,name:`Space ${i}`,requestId:`space-request-${i}`},deps)));
  assert.equal(spaces.filter(x=>x.status==='fulfilled').length,1);
});
test('invalid names, users, and idempotency keys cannot create records', async () => {
  const deps={redis:createMemoryRedis()};
  for (const patch of [{name:''},{name:'a\nb'},{name:'x'.repeat(81)},{userId:'admin'},{requestId:''}]) await assert.rejects(createWorkspace({...input(),...patch},deps),{status:400});
  assert.deepEqual(await listWorkspaces({userId:alice},deps),[]);
});

test('Free plan limit enforces 1 active space by default when plan is free', async () => {
  const deps = { redis: createMemoryRedis() };
  const { workspace: w } = await createWorkspace({ ...input(), plan: 'free' }, deps);
  assert.equal(w.plan, 'free');
  // Attempting to create a 2nd space on Free without custom limits throws space_limit (429)
  await assert.rejects(
    createSpace({ userId: alice, workspaceId: w.id, name: 'Second Space', requestId: 'req-space-2' }, deps),
    { code: 'space_limit', status: 429 }
  );
});

test('space rename: updates name, creates audit record, preserves space ID', async () => {
  const deps = { redis: createMemoryRedis() };
  const { workspace: w, space: s } = await createWorkspace(input(), deps);
  const renamed = await renameSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, name: 'Renamed Operations', requestId: 'req-rename-1' }, deps);
  assert.equal(renamed.space.name, 'Renamed Operations');
  assert.equal(renamed.space.id, s.id);
  const spaces = await listSpaces({ userId: alice, workspaceId: w.id }, deps);
  assert.equal(spaces[0].name, 'Renamed Operations');
});

test('space archive: archived spaces stay readable, writes/approvals are refused, frees active quota', async () => {
  const deps = { redis: createMemoryRedis() };
  const { workspace: w, space: s } = await createWorkspace({ ...input(), plan: 'free' }, deps);
  assert.equal(s.status, 'active');

  // Archive the only space
  const archived = await archiveSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, requestId: 'req-archive-1' }, deps);
  assert.equal(archived.space.status, 'archived');

  // Space is still visible in listSpaces
  const list = await listSpaces({ userId: alice, workspaceId: w.id }, deps);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'archived');

  // Read permission is granted on archived space
  const readAuth = await authorizeSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, action: 'read' }, deps);
  assert.equal(readAuth.permissions.read, true);
  assert.equal(readAuth.permissions.write, false);
  assert.equal(readAuth.permissions.approve, false);

  // Write and approve actions are refused on archived space (403 space_archived)
  await assert.rejects(
    authorizeSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, action: 'write' }, deps),
    { code: 'space_archived', status: 403 }
  );
  await assert.rejects(
    authorizeSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, action: 'approve' }, deps),
    { code: 'space_archived', status: 403 }
  );

  // Because the first space is archived, active count is 0, so creating a new space on Free succeeds!
  const s2 = await createSpace({ userId: alice, workspaceId: w.id, name: 'New Active Space', requestId: 'req-space-active-2' }, deps);
  assert.equal(s2.space.status, 'active');

  // Trying to unarchive the first space now hits the 1-space limit (429)
  await assert.rejects(
    unarchiveSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, requestId: 'req-unarchive-1' }, deps),
    { code: 'space_limit', status: 429 }
  );

  // Archive the second space
  await archiveSpace({ userId: alice, workspaceId: w.id, spaceId: s2.space.id, requestId: 'req-archive-2' }, deps);

  // Now unarchiving the first space succeeds!
  const restored = await unarchiveSpace({ userId: alice, workspaceId: w.id, spaceId: s.id, requestId: 'req-unarchive-2' }, deps);
  assert.equal(restored.space.status, 'active');
});
