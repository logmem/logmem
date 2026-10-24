import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createJail,createSpaceJail} from '../src/http/jail.mjs';
test('new space jail cannot access legacy or sibling namespaces',async()=>{
 const redis=createMemoryRedis(),ns='s-aaaaaaaaaaaaaaaaaaaaaaaa';
 const r=createSpaceJail(redis,{tenantId:'business123',namespace:ns});
 await r('SET',`lm:${ns}:key`,'ok');
 for(const k of ['lm:t-business123:key','lm:s-bbbbbbbbbbbbbbbbbbbbbbbb:key'])await assert.rejects(r('GET',k),{status:403});
 await assert.rejects(createJail(redis,'business123')('GET',`lm:${ns}:key`),{status:403});
 assert.throws(()=>createSpaceJail(redis,{tenantId:'business123',namespace:'madez'}));
});
