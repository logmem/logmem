import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { createWorkspace, createSpace, listWorkspaces, listSpaces } from '../src/http/workspaces.mjs';
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
