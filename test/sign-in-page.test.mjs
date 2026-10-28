import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,frontendForKey} from '../api/sign-in.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';
const key='pk_test_'+Buffer.from('test-login.clerk.accounts.dev$').toString('base64');
test('branded login exposes only the publishable key and keeps the requested workspace destination',async()=>{
 const h=createHandler({env:{CLERK_PUBLISHABLE_KEY:key,CLERK_SECRET_KEY:'server-secret-never-emit'}}),r=mockRes();
 await h(mockReq({url:'/sign-in?returnTo='+encodeURIComponent('/app?setup=managed#/account')}),r);
 assert.equal(r.statusCode,200);assert.match(r.body,/Sign in · LogMem/);assert.match(r.body,/logmem-lockup.svg/);assert.match(r.body,/data-return-to="\/app\?setup=managed#\/account"/);assert.ok(!r.body.includes('server-secret-never-emit'));
 assert.match(r.headers['content-security-policy'],/https:\/\/test-login.clerk.accounts.dev/);assert.ok(!r.headers['content-security-policy'].includes("'unsafe-eval'"));
 assert.equal(r.headers['cache-control'],'no-store');
});
test('branded login rejects external, encoded and malformed return destinations',async()=>{
 const h=createHandler({env:{CLERK_PUBLISHABLE_KEY:key}});
 for(const value of ['https://evil.example','//evil.example','/%252fevil.example','/app\\evil','/app%0d%0aX:y']){
  const r=mockRes();await h(mockReq({url:'/sign-in?returnTo='+encodeURIComponent(value)}),r);assert.equal(r.statusCode,400,value);
 }
});
test('missing login config returns a branded unavailable page without a provider script',async()=>{
 const r=mockRes();await createHandler({env:{}})(mockReq({url:'/sign-in'}),r);assert.equal(r.statusCode,503);assert.match(r.body,/Sign-in is unavailable/);assert.match(r.body,/logmem-lockup.svg/);assert.match(r.body,/data-clerk-key=""/);
});
test('provider scripts must come from a valid configured publishable key domain',()=>{
 for(const domain of ['evil.example/path$','x\" onload=alert(1)$','https://bad.example$','x..example.com$'])assert.equal(frontendForKey('pk_test_'+Buffer.from(domain).toString('base64')),'');
 assert.equal(frontendForKey(key),'https://test-login.clerk.accounts.dev');
});
