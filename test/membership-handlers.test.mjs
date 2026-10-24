import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createWorkspace} from '../src/http/workspaces.mjs';
import {createHandler} from '../api/memberships.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
const userId='user_owner00000001';
test('membership API binds identity, requires intent, and does not expose invitation hashes',async()=>{
 const redis=createMemoryRedis();const {workspace:w,space:s}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},{redis});
 const d={redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1'},session:async()=>({status:'signed-in',userId,email:'owner@example.com'})},h=createHandler(d);
 const b={action:'invite',workspaceId:w.id,email:'member@example.com',role:'member',spaces:{[s.id]:{role:'editor',canApprove:false}},requestId:'invite-001'};
 let r=mockRes();await h(mockReq({method:'POST',url:'/api/memberships',body:b}),r);assert.equal(r.statusCode,403);
 r=mockRes();await h(mockReq({method:'POST',url:'/api/memberships',headers:{origin:'https://logmem.test','x-logmem-intent':'memberships'},body:b}),r);assert.equal(r.statusCode,200);assert.ok(JSON.parse(r.body).token);
 r=mockRes();await h(mockReq({url:'/api/memberships?workspaceId='+w.id}),r);assert.equal(r.statusCode,200);assert.ok(!r.body.includes('emailDigest'));assert.ok(!r.body.includes('hash'));assert.ok(!r.body.includes('lmi_'));
 r=mockRes();await createHandler({...d,session:async()=>({status:'signed-in',userId:'user_other00000001'})})(mockReq({url:'/api/memberships?workspaceId='+w.id}),r);assert.equal(r.statusCode,404);
});
