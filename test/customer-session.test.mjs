import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryRedis} from '../src/lib/memory-redis.mjs';
import {createHandler} from '../api/session.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
import {createWorkspace} from '../src/http/workspaces.mjs';
const userId='user_customer00001';
const deps=redis=>({redis,env:{LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1'},session:async()=>({status:'signed-in',userId,email:'a@example.com',sessionId:'sess_test'})});
test('customer session lists memberships without provisioning an unwanted workspace',async()=>{
 const redis=createMemoryRedis(),handler=createHandler(deps(redis));
 let r=mockRes();await handler(mockReq({url:'/api/session'}),r);
 assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).onboarding,true);
 await createWorkspace({userId,name:'Business',firstSpaceName:'Ops',requestId:'create-001'},{redis});
 r=mockRes();await handler(mockReq({url:'/api/session'}),r);const data=JSON.parse(r.body);
 assert.equal(data.workspaces.length,1);assert.equal(data.spaces.length,1);assert.equal(data.onboarding,false);
 assert.ok(!r.body.includes('members'));
});
test('signin accepts only local return paths and preserves handshake cookies',async()=>{
 const redis=createMemoryRedis();
 for(const path of ['https://evil.test','//evil.test','/\\evil.test','/%2f%2fevil.test']){
  const r=mockRes();await createHandler(deps(redis))(mockReq({url:'/api/session?signin=1&returnTo='+encodeURIComponent(path)}),r);assert.equal(r.statusCode,400);
 }
 const r=mockRes();await createHandler({...deps(redis),session:async()=>({status:'handshake',headers:[['set-cookie','a=1'],['set-cookie','b=2'],['location','https://accounts.example/handshake']]})})(mockReq({url:'/api/session?signin=1'}),r);
 assert.equal(r.statusCode,307);assert.deepEqual(r.getHeader('set-cookie'),['a=1','b=2']);
});
test('profile settings send the signed-in user to the Clerk account portal',async()=>{
 const redis=createMemoryRedis(),key='pk_test_'+Buffer.from('lenient-newt-9425.accounts.dev$').toString('base64');
 const handler=createHandler({...deps(redis),env:{LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1',CLERK_PUBLISHABLE_KEY:key}});
 const r=mockRes();await handler(mockReq({url:'/api/session?profile=1',headers:{host:'logmem.test'}}),r);
 assert.equal(r.statusCode,302);
 const destination=new URL(r.getHeader('location'));
 assert.equal(destination.origin,'https://lenient-newt-9425.accounts.dev');
 assert.equal(destination.pathname,'/user');
 assert.equal(destination.searchParams.get('redirect_url'),'https://logmem.test/app#/account');
});
test('signout requires origin and intent and revokes the actual provider session',async()=>{
 const redis=createMemoryRedis();let revoked;
 const handler=createHandler({...deps(redis),revokeSession:async id=>{revoked=id;}});
 let r=mockRes();await handler(mockReq({method:'POST',url:'/api/session',body:{action:'signout'}}),r);assert.equal(r.statusCode,403);
 r=mockRes();await handler(mockReq({method:'POST',url:'/api/session',headers:{origin:'https://logmem.test','x-logmem-intent':'session'},body:{action:'signout'}}),r);
 assert.equal(r.statusCode,200);assert.equal(revoked,'sess_test');
});
