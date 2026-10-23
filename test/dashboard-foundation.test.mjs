import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedBusinessDemos } from '../scripts/seed-business-demos.mjs';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { buildView } from '../src/http/view.mjs';
import { createHandler } from '../api/work.mjs';
import { mockReq, mockRes } from './oauth-helpers.mjs';

const model = await import('../public/app/dashboard-model.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const call = async (handler, method, url) => {
  const res = mockRes();
  await handler(mockReq({ method, url, headers: { host: 'localhost' }, body: {} }), res);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
};

test('dashboard: actual sample Home includes decision context and bounded source updates', async () => {
  const redis = createMemoryRedis();
  await seedBusinessDemos(redis);
  const d = await buildView(redis, 'demo-restaurant', 'home');
  assert.equal(d.needs_items?.length, 1);
  assert.equal(d.needs_items[0].type, 'decision');
  assert.ok(d.needs_items[0].ask.payload.action.length > 0);
  assert.ok(d.recent?.length > 0);
  assert.ok(d.recent.every(e => e.where.startsWith('job:')));
  assert.equal(d.coverage?.complete, false);
  assert.ok(d.coverage.notes.some(x => /coordination/i.test(x)));
});

test('dashboard: an unreadable job is disclosed instead of a complete empty state', async () => {
  const redis = createMemoryRedis();
  await seedBusinessDemos(redis);
  const failing = (cmd, ...args) => {
    if (String(cmd).toUpperCase() === 'GET' && String(args[0]).includes(':job:friday-service-3:who')) throw new Error('offline');
    return redis(cmd, ...args);
  };
  const d = await buildView(failing, 'demo-restaurant', 'home');
  assert.equal(d.coverage?.complete, false);
  assert.ok(d.coverage?.errors.some(x => x.source === 'job:friday-service-3'));
});

test('dashboard: sample GET needs works while unauthenticated writes remain refused', async () => {
  const redis = createMemoryRedis();
  await seedBusinessDemos(redis);
  const handler = createHandler({ redis, env: { LOGMEM_VIEW_SPACES: 'demo-restaurant' } });
  const r = await call(handler, 'GET', '/api/work?op=needs&space=demo-restaurant');
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal((await call(handler, 'POST', '/api/work?op=nudge')).status, 401);
  assert.equal((await call(handler, 'GET', '/api/work?op=needs&space=other')).status, 403);
});

test('dashboard: production and password-configured preview still protect GET needs', async () => {
  const redis = createMemoryRedis();
  for (const env of [{ VERCEL_ENV: 'production' }, { LOGMEM_ADMIN_PASSWORD: 'sample-test-password' }]) {
    const handler = createHandler({ redis, env: { ...env, LOGMEM_VIEW_SPACES: 'demo-restaurant' } });
    assert.equal((await call(handler, 'GET', '/api/work?op=needs&space=demo-restaurant')).status, 401);
    assert.equal((await call(handler, 'POST', '/api/work?op=nudge')).status, 401);
  }
});

test('dashboard: work order preserves unknown stages and excludes milestones', () => {
  const jobs = [
    { id:'z', stage:'done' }, { id:'b', stage:'active' }, { id:'a', stage:'active' },
    { id:'m', stage:'blocked', blocked_on:{type:'decision'} },
    { id:'x', stage:'mystery' }, { id:'n', milestone:true, stage:'blocked' },
    { id:'o', stage:'open' }, { id:'w', stage:'blocked', blocked_on:{type:'external'} },
  ];
  const result = model.prioritizeWork?.(jobs, Date.UTC(2026,9,23));
  assert.deepEqual(result?.map(j => j.id), ['m','w','x','a','b','o','z']);
  assert.equal(result?.find(j=>j.id==='x').owner, undefined);
});

test('dashboard: brief summarizes real structured observations without an all-clear claim', () => {
  const d = { needs_count:1, needs_items:[{type:'decision'}], blocked:[{id:'a'},{id:'b'}], plans:[{jobs:5,done:1}], coverage:{complete:false} };
  const result = model.briefFor?.(d);
  assert.equal(result?.decisions, 1);
  assert.equal(result?.blocked, 2);
  assert.equal(result?.done, 1);
  assert.equal(result?.total, 5);
  assert.equal(result?.partial, true);
});

test('dashboard: missing actions cannot be approved and requested changes require a reason', () => {
  assert.ok(model.decisionProblem?.({payload:{}}, 'approve', ''));
  assert.ok(model.decisionProblem?.({payload:{action:'Send quote v3'}}, 'reject', '  '));
  assert.equal(model.decisionProblem?.({payload:{action:'Send quote v3'}}, 'approve', ''), null);
  assert.equal(model.decisionProblem?.({payload:{}}, 'defer', ''), null);
  assert.equal(model.decisionProblem?.({payload:{action:'Send quote v3'}}, 'reject', 'Change the scope'), null);
});

test('dashboard: seeded spaces are labeled as samples without mislabeling a real workspace', () => {
  assert.equal(model.isSampleSpace?.('demo-restaurant'), true);
  assert.equal(model.isSampleSpace?.('demo-sales'), true);
  assert.equal(model.isSampleSpace?.('fieldnotes'), true);
  assert.equal(model.isSampleSpace?.('madez'), false);
});

