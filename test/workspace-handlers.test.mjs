import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createHandler} from '../api/workspaces.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
const userId='user_customer00001';
test('workspace handler requires verified session, signup access, intent and idempotency',async()=>{
 const redis=createMemoryRedis(),deps={redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1'},session:async()=>({status:'signed-in',userId,email:'a@example.com'})};
 const request={method:'POST',url:'/api/workspaces',headers:{origin:'https://logmem.test','x-logmem-intent':'workspace'},body:{action:'create-workspace',name:'Business',firstSpaceName:'Ops',requestId:'create-001'}};
 let r=mockRes();await createHandler({...deps,session:async()=>({status:'signed-out'})})(mockReq(request),r);assert.equal(r.statusCode,401);
 r=mockRes();await createHandler({...deps,env:{LOGMEM_CUSTOMER_DASHBOARD:'1'}})(mockReq(request),r);assert.equal(r.statusCode,403);
 r=mockRes();await createHandler(deps)(mockReq(request),r);assert.equal(r.statusCode,200);const result=JSON.parse(r.body);assert.ok(result.workspace.id);assert.ok(!r.body.includes('members'));
 r=mockRes();await createHandler(deps)(mockReq({...request,headers:{...request.headers,origin:'https://evil.test'}}),r);assert.equal(r.statusCode,403);
});
test('optional business samples use the new private namespace and seed only once',async()=>{
 const redis=createMemoryRedis(),deps={redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1'},session:async()=>({status:'signed-in',userId,email:'a@example.com'})},h=createHandler(deps);
 const request={method:'POST',url:'/api/workspaces',headers:{origin:'https://logmem.test','x-logmem-intent':'workspace'},body:{action:'create-workspace',name:'Business',firstSpaceName:'Ops',businessType:'trades',withSample:true,requestId:'sample-001'}};
 const first=mockRes();await h(mockReq(request),first);assert.equal(first.statusCode,200);const r=JSON.parse(first.body);assert.equal(r.workspace.businessType,'trades');assert.equal(r.sampleStatus,'complete');
 const before=await redis('ZCARD',`lm:${r.space.namespace}:job:${r.sampleJobs[0]}:log`);
 const second=mockRes();await h(mockReq(request),second);assert.equal(second.statusCode,200);assert.equal(await redis('ZCARD',`lm:${r.space.namespace}:job:${r.sampleJobs[0]}:log`),before);
 assert.equal(await redis('EXISTS','lm:demo-trades:agents'),0);
});
test('an invited workspace member can create a space while public signup stays closed',async()=>{
 const {createWorkspace,setMembership}=await import('../src/http/workspaces.mjs');const redis=createMemoryRedis(),member='user_teammate00001';
 const {workspace:w}=await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},{redis});await setMembership({actorId:userId,workspaceId:w.id,userId:member,role:'member',spaces:{},requestId:'member-001'},{redis});
 const handler=createHandler({redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1'},session:async()=>({status:'signed-in',userId:member,email:'member@example.com'})}),res=mockRes();
 await handler(mockReq({method:'POST',url:'/api/workspaces',headers:{origin:'https://logmem.test','x-logmem-intent':'workspace'},body:{action:'create-space',workspaceId:w.id,name:'Team work',requestId:'new-space-01'}}),res);
 assert.equal(res.statusCode,200,res.body);
});
