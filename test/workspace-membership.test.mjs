import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace,createSpace,authorizeSpace,setMembership,removeMembership,listSpaces} from '../src/http/workspaces.mjs';
const owner='user_owner00000001',member='user_member0000001',other='user_other00000001';
async function setup() {const deps={redis:createMemoryRedis()};const {workspace,space}=await createWorkspace({userId:owner,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},deps);return {deps,workspace,space};}
test('member grants restrict sibling spaces and separate edits from approvals',async()=>{
 const {deps,workspace:w,space:s}=await setup();const b=await createSpace({userId:owner,workspaceId:w.id,name:'Private',requestId:'space-002'},deps);
 await setMembership({actorId:owner,workspaceId:w.id,userId:member,role:'member',spaces:{[s.id]:{role:'editor',canApprove:false}},requestId:'member-001'},deps);
 assert.equal((await authorizeSpace({userId:member,workspaceId:w.id,spaceId:s.id,action:'write'},deps)).person,`human:${member}`);
 await assert.rejects(authorizeSpace({userId:member,workspaceId:w.id,spaceId:s.id,action:'approve'},deps),{status:403});
 await assert.rejects(authorizeSpace({userId:member,workspaceId:w.id,spaceId:b.space.id,action:'read'},deps),{status:404});
 assert.equal((await listSpaces({userId:member,workspaceId:w.id},deps)).length,1);
 await removeMembership({actorId:owner,workspaceId:w.id,userId:member,requestId:'remove-001'},deps);
 await assert.rejects(authorizeSpace({userId:member,workspaceId:w.id,spaceId:s.id,action:'read'},deps),{status:404});
});
test('admins cannot grant owner or approval powers and viewers cannot edit',async()=>{
 const {deps,workspace:w,space:s}=await setup();
 await setMembership({actorId:owner,workspaceId:w.id,userId:member,role:'admin',spaces:{},requestId:'member-001'},deps);
 for(const patch of [{role:'owner',spaces:{}},{role:'member',spaces:{[s.id]:{role:'editor',canApprove:true}}}]) await assert.rejects(setMembership({actorId:member,workspaceId:w.id,userId:other,requestId:'escalate-1',...patch},deps),{status:403});
 await assert.rejects(authorizeSpace({userId:member,workspaceId:w.id,spaceId:s.id,action:'approve'},deps),{status:403});
 await setMembership({actorId:owner,workspaceId:w.id,userId:other,role:'viewer',spaces:{[s.id]:{role:'viewer',canApprove:false}},requestId:'viewer-001'},deps);
 await authorizeSpace({userId:other,workspaceId:w.id,spaceId:s.id,action:'read'},deps);
 await assert.rejects(authorizeSpace({userId:other,workspaceId:w.id,spaceId:s.id,action:'write'},deps),{status:403});
});
test('concurrent owner removals always retain at least one owner',async()=>{
 const {deps,workspace:w}=await setup();
 await setMembership({actorId:owner,workspaceId:w.id,userId:member,role:'owner',spaces:{},requestId:'promote-01'},deps);
 const r=await Promise.allSettled([removeMembership({actorId:owner,workspaceId:w.id,userId:owner,requestId:'remove-001'},deps),removeMembership({actorId:member,workspaceId:w.id,userId:member,requestId:'remove-002'},deps)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
});
