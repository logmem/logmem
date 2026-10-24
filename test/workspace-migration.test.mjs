import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createTenant} from '../cloud/tenants/index.mjs';
import {ensureLegacyWorkspace,authorizeSpace} from '../src/http/workspaces.mjs';
const userId='user_legacy0000001';
test('legacy metadata migration preserves namespace, data, and ownership',async()=>{
 const redis=createMemoryRedis(),deps={redis}; await createTenant(redis,{id:'legacy123'});
 await redis('SET','lm:account:tenant:legacy123',userId);await redis('SET','lm:t-legacy123:sentinel','unchanged');
 const [a,b]=await Promise.all([ensureLegacyWorkspace({userId,tenantId:'legacy123'},deps),ensureLegacyWorkspace({userId,tenantId:'legacy123'},deps)]);
 assert.equal(a.space.namespace,'t-legacy123');assert.equal(b.space.id,a.space.id);
 assert.equal(await redis('GET','lm:t-legacy123:sentinel'),'unchanged');
 await assert.rejects(ensureLegacyWorkspace({userId:'user_intruder00001',tenantId:'legacy123'},deps),{status:404});
 await redis('HSET','acmi:cloud:tenant:legacy123','status','suspended');
 await assert.rejects(authorizeSpace({userId,workspaceId:a.workspace.id,spaceId:a.space.id,action:'read'},deps),{status:404});
});
