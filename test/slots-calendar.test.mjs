import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createStore} from '../src/core/store.mjs';
import {getAgentSlotsView} from '../src/core/sync.mjs';
const states = async (date,now) => Object.values((await getAgentSlotsView(createStore(createMemoryRedis(),{space:'fleet'}),'fleet','codex',date,Date.parse(now))).slots).map(x=>x.state);
test('empty past dates are missed and future dates stay pending',async()=>{
 assert.deepEqual(await states('2026-10-23','2026-10-24T13:00:00-04:00'),['missed','missed','missed']);
 assert.deepEqual(await states('2026-10-25','2026-10-24T13:00:00-04:00'),['pending','pending','pending']);
});
test('all empty slots are missed after the closeout window',async()=>{
 assert.deepEqual(await states('2026-10-24','2026-10-24T22:01:00-04:00'),['missed','missed','missed']);
 assert.deepEqual(await states('2026-10-24','2026-10-24T05:00:00-04:00'),['pending','pending','pending']);
});
