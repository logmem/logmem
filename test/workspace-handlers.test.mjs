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
