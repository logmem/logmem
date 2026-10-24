import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createTenant} from '../cloud/tenants/index.mjs';
import {migrateWorkspaces} from '../scripts/workspace-migrate.mjs';
const userId='user_legacy0000001';
test('workspace migration is dry by default and preserves existing data and grants',async()=>{
 const redis=createMemoryRedis();await createTenant(redis,{id:'legacy123'});
 await redis('SET','lm:account:tenant:legacy123',userId);await redis('SET',`lm:account:clerk:${userId}`,'legacy123');await redis('SET','lm:t-legacy123:sentinel','original');
 const before=JSON.stringify([...redis._data]);
 const dry=await migrateWorkspaces({redis});assert.equal(dry[0].status,'would-map');assert.equal(JSON.stringify([...redis._data]),before);
 const first=await migrateWorkspaces({redis,apply:true});assert.equal(first[0].status,'mapped');
 const second=await migrateWorkspaces({redis,apply:true});assert.equal(second[0].status,'already-mapped');
 assert.equal(await redis('GET','lm:t-legacy123:sentinel'),'original');
});
test('migration skips paused, unowned, and conflicting accounts',async()=>{
 const redis=createMemoryRedis();await createTenant(redis,{id:'legacy123'});await redis('SET','lm:account:tenant:legacy123',userId);await redis('SET',`lm:account:clerk:${userId}`,'different123');
 assert.equal((await migrateWorkspaces({redis,apply:true}))[0].status,'skipped');
 assert.equal(await redis('GET','lm:workspace:record:legacy123'),null);
});
