import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace,createSpace,setMembership,removeMembership} from '../src/http/workspaces.mjs';
import {resolveViewer} from '../src/http/viewer.mjs';
const userId='user_owner00000001',member='user_member0000001';
async function setup(){const redis=createMemoryRedis();const a=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},{redis});return {redis,...a};}
test('viewer resolves verified identity and jails reads and writes to the selected space',async()=>{
 const {redis,workspace:w,space:s}=await setup();const deps={redis,session:async()=>({status:'signed-in',userId,email:'test@example.com'})};
 const v=await resolveViewer({headers:{}},{workspaceId:w.id,spaceId:s.id,action:'write'},deps);
 assert.equal(v.person,`human:${userId}`);
 await v.redis('SET',`lm:${s.namespace}:test`,'owned');assert.equal(await v.redis('GET',`lm:${s.namespace}:test`),'owned');
 for(const k of ['lm:madez:test','lm:workspace:record:'+w.id,'lm:s-aaaaaaaaaaaaaaaaaaaaaaaa:test']) await assert.rejects(v.redis('GET',k),{status:403});
 await assert.rejects(resolveViewer({headers:{}},{workspaceId:w.id,spaceId:s.id,action:'read'},{...deps,session:async()=>({status:'signed-out'})}),{status:401});
});
test('revoked member cannot use a previously resolved runner',async()=>{
 const {redis,workspace:w,space:s}=await setup();
 await setMembership({actorId:userId,workspaceId:w.id,userId:member,role:'member',spaces:{[s.id]:{role:'editor',canApprove:false}},requestId:'member-001'},{redis});
 const v=await resolveViewer({headers:{}},{workspaceId:w.id,spaceId:s.id,action:'write'},{redis,session:async()=>({status:'signed-in',userId:member})});
 await removeMembership({actorId:userId,workspaceId:w.id,userId:member,requestId:'remove-001'},{redis});
 await assert.rejects(v.redis('SET',`lm:${s.namespace}:test`,'forbidden'),{status:404});
 assert.equal(await redis('GET',`lm:${s.namespace}:test`),null);
});
