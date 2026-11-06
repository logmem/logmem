import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
test('session response hands the browser the public Clerk bootstrap and no secret',async()=>{
 const redis=createMemoryRedis(),key='pk_test_'+Buffer.from('lenient-newt-9425.accounts.dev$').toString('base64');
 const env={LOGMEM_CUSTOMER_DASHBOARD:'1',LOGMEM_SIGNUP_OPEN:'1',CLERK_PUBLISHABLE_KEY:key,CLERK_SECRET_KEY:'sk_test_hidden'};
 let r=mockRes();await createHandler({...deps(redis),env})(mockReq({url:'/api/session'}),r);
 const data=JSON.parse(r.body);
 assert.equal(data.clerk.publishableKey,key);assert.match(data.clerk.frontend,/^https:\/\/.+accounts\.dev$/);
 assert.ok(!r.body.includes('sk_test'));
 r=mockRes();await createHandler(deps(redis))(mockReq({url:'/api/session'}),r);
 assert.equal(JSON.parse(r.body).clerk,null);
});
test('app CSP lets clerk-js load from the real development host',()=>{
 const rules=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8')).headers.filter(h=>/\/app/.test(h.source));
 assert.ok(rules.length>0);
 for(const rule of rules){const csp=rule.headers.find(h=>h.key==='Content-Security-Policy').value;
  assert.match(csp,/script-src 'self' https:\/\/\*\.accounts\.dev/);assert.match(csp,/connect-src 'self' https:\/\/\*\.accounts\.dev/);assert.ok(!csp.includes("'unsafe-eval'"));}
});
test('cold start takes one handshake when Clerk says a session exists, and mutations retry once',()=>{
 const account=fs.readFileSync(new URL('../public/app/account.js',import.meta.url),'utf8'),core=fs.readFileSync(new URL('../public/app/core.js',import.meta.url),'utf8');
 assert.match(account,/__client_uat=/);assert.match(account,/\/api\/session\?signin=1&returnTo=/);assert.match(account,/res\.status===401&&coldHandshake\(\)/);
 assert.match(core,/r\.status===401&&sessionRefresher&&await sessionRefresher\(\)\)r=await send\(\)/);
});
