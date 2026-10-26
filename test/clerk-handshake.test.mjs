import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clerkSession} from '../src/http/clerk.mjs';
import {createHandler} from '../api/session.mjs';
import {mockReq,mockRes} from './oauth-helpers.mjs';

const env={LOGMEM_CUSTOMER_DASHBOARD:'1',CLERK_SECRET_KEY:'test-only-secret',CLERK_PUBLISHABLE_KEY:'pk_test_'+Buffer.from('example.clerk.accounts.dev$').toString('base64')};
const callback='https://logmem.test/api/session?signin=1&returnTo=%2Fapp&__clerk_handshake_nonce=test-only-nonce';
const cleanCallback='https://logmem.test/api/session?signin=1&returnTo=%2Fapp';
const cookies=['__session=test-only-session; Path=/; HttpOnly; Secure; SameSite=Lax','__client_uat=1; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; SameSite=Lax'];

// Only the external provider boundary is replaced. Headers and the LogMem adapter and route are real.
function clientFor(status,headers=new Headers()) {
 return {authenticateRequest:async()=>({status,headers,toAuth:()=>({userId:'user_handshake',sessionId:'sess_handshake'})}),users:{getUser:async()=>({primaryEmailAddressId:'email1',emailAddresses:[{id:'email1',emailAddress:'test@example.com',verification:{status:'verified'}}]})}};
}
function providerHeaders(location) {
 const headers=new Headers();
 for(const cookie of cookies)headers.append('Set-Cookie',cookie);
 if(location)headers.set('Location',location);
 return headers;
}
async function signin(status,headers) {
 const client=clientFor(status,headers),res=mockRes();
 const session=(req,options)=>clerkSession(req,{...options,client});
 await createHandler({env,session})(mockReq({url:new URL(callback).pathname+new URL(callback).search}),res);
 return res;
}

test('verified Clerk callback sets browser cookies before returning to the application',async()=>{
 const res=await signin('signed-in',providerHeaders(cleanCallback));
 assert.deepEqual(res.getHeader('set-cookie'),cookies);
 assert.equal(res.statusCode,307);
 assert.equal(res.getHeader('location'),cleanCallback);
});
test('Clerk handshake preserves separate cookies including an Expires comma',async()=>{
 const res=await signin('handshake',providerHeaders('https://example.clerk.accounts.dev/v1/client/handshake'));
 assert.deepEqual(res.getHeader('set-cookie'),cookies);
 assert.equal(res.statusCode,307);
});
test('production callback with cookies but no redirect persists them and clears transport parameters',async()=>{
 const res=await signin('signed-in',providerHeaders());
 assert.deepEqual(res.getHeader('set-cookie'),cookies);
 assert.equal(res.statusCode,307);
 assert.equal(res.getHeader('location'),cleanCallback);
});
test('signed-out callback clears cookies before starting another sign-in',async()=>{
 const headers=new Headers({'Location':cleanCallback});
 headers.append('Set-Cookie','__session=; Path=/; Max-Age=0; HttpOnly; Secure');
 const res=await signin('signed-out',headers);
 assert.deepEqual(res.getHeader('set-cookie'),['__session=; Path=/; Max-Age=0; HttpOnly; Secure']);
 assert.equal(res.getHeader('location'),cleanCallback);
});
test('ordinary verified session reaches its validated application destination without another handshake',async()=>{
 const res=await signin('signed-in',new Headers());
 assert.equal(res.statusCode,302);
 assert.equal(res.getHeader('location'),'/app');
 assert.equal(res.getHeader('set-cookie'),undefined);
});

test('partyOrigins accepts both the instance domain forms a dev token may name', async () => {
  const { partyOrigins } = await import('../src/http/clerk.mjs');
  const pk = 'pk_test_' + Buffer.from('lenient-newt-9425.clerk.accounts.dev$').toString('base64');
  assert.deepEqual(partyOrigins(pk), [
    'https://lenient-newt-9425.clerk.accounts.dev',
    'https://lenient-newt-9425.accounts.dev',
  ]);
  assert.deepEqual(partyOrigins('not-a-key'), []);
  assert.deepEqual(partyOrigins(''), []);
});
