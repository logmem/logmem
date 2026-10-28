import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDay } from '../api/scorecard.mjs';
import { auditView } from '../src/http/view.mjs';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { createStore } from '../src/core/store.mjs';

const base = { date: '2026-10-28', window: [1793106000000, 1793192400000], mirror_opt_out: 12 };
test('scorecard keeps the audit window and opt-out count without exposing writer details', () => {
  const row = cleanDay({ ...base, mirror_opt_out_writers: ['private-writer'], mismatch_examples: [{ trail: 'private' }] }, 'fleet');
  assert.deepEqual(row.window, base.window);
  assert.equal(row.mirror_opt_out, 12);
  assert.equal(row.mirror_opt_out_writers, undefined);
  assert.deepEqual(row.mismatch_examples, []);
  row.window[0] = 1;
  assert.equal(base.window[0], 1793106000000);
});
test('scorecard rejects malformed audit windows and opt-out counts', () => {
  for (const window of [undefined, [2, 1], [0, 2], ['1', 2], [1, Infinity], [1, 2, 3]]) {
    assert.equal(cleanDay({ ...base, window }, 'fleet').window, null);
  }
  for (const mirror_opt_out of [-1, 1.5, Infinity, 'bad']) {
    assert.equal(cleanDay({ ...base, mirror_opt_out }, 'fleet').mirror_opt_out, 0);
  }
});

test('successful empty audit reads are distinct from unavailable sources', async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: 'fleet' });
  const result = await auditView(store, redis, 'fleet');
  assert.deepEqual(result.source_status, { receipts: 'ok', audit: 'ok' });
  assert.deepEqual(result.slots, []);
  assert.deepEqual(result.days, []);
});

test('receipt read failure stays explicit while audit history remains available', async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: 'fleet' });
  await store.setWho('agent', 'quill', { name: 'Quill' });
  const failing = (...args) => {
    if (args[0] === 'LRANGE' && String(args[1]).includes(':sync:slot:')) throw new Error('private backend detail');
    return redis(...args);
  };
  const result = await auditView(createStore(failing, { space: 'fleet' }), failing, 'fleet');
  assert.deepEqual(result.source_status, { receipts: 'error', audit: 'ok' });
  assert.deepEqual(result.slots, []);
  assert.ok(!JSON.stringify(result).includes('private backend detail'));
});

test('audit read failure stays explicit while receipt reads remain available', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (callback) => { callback(); return 0; });
  const redis = createMemoryRedis();
  const failing = (...args) => {
    if (String(args[1]).includes(':job:logmem-dogfood:log')) throw new Error('private backend detail');
    return redis(...args);
  };
  const result = await auditView(createStore(failing, { space: 'fleet' }), failing, 'fleet');
  assert.deepEqual(result.source_status, { receipts: 'ok', audit: 'error' });
  assert.deepEqual(result.days, []);
  assert.ok(!JSON.stringify(result).includes('private backend detail'));
});
