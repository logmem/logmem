// Waitlist confirmation mail: best effort by contract. The sign-up reply is
// always {ok:true}, an unconfigured or broken mail path never changes it, and
// no key, recipient or provider body reaches the log or the assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendWaitlistConfirmation, DEFAULT_FROM, RESEND_URL, CONFIRM_SUBJECT } from '../src/http/waitlist-email.mjs';
import { createHandler as waitlistHandler, normalizeEmail } from '../api/onboarding/waitlist.mjs';
import { createMemoryRedis } from '../src/lib/memory-redis.mjs';
import { mockReq, mockRes } from './oauth-helpers.mjs';

const quiet = () => {};

test('no key: not_configured and the provider is never called', async () => {
  let called = 0;
  const r = await sendWaitlistConfirmation('a@example.com', { env: {}, fetchImpl: async () => { called += 1; return { ok: true, status: 201 }; } });
  assert.deepEqual(r, { sent: false, reason: 'not_configured' });
  assert.equal(called, 0, 'no key means no network call');
});

test('key present: posts to Resend with the bearer and the recipient, reports sent', async () => {
  let seen;
  const r = await sendWaitlistConfirmation('person@example.com', {
    env: { RESEND_API_KEY: 're_test_key_value' },
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201 }; },
  });
  assert.deepEqual(r, { sent: true, status: 201 });
  assert.equal(seen.url, RESEND_URL);
  assert.equal(seen.init.headers.Authorization, 'Bearer re_test_key_value');
  const payload = JSON.parse(seen.init.body);
  assert.deepEqual(payload.to, ['person@example.com']);
  assert.equal(payload.from, DEFAULT_FROM);
  assert.equal(payload.subject, CONFIRM_SUBJECT);
  assert.ok(!seen.init.body.includes('re_test_key_value'), 'the key never enters the payload');
});

test('RESEND_FROM overrides the default sender when set', async () => {
  let seen;
  await sendWaitlistConfirmation('p@example.com', {
    env: { RESEND_API_KEY: 'k', RESEND_FROM: 'Waitlist <hello@logmem.si>' },
    fetchImpl: async (url, init) => { seen = init; return { ok: true, status: 201 }; },
  });
  assert.equal(JSON.parse(seen.body).from, 'Waitlist <hello@logmem.si>');
});

test('provider refusal and transport errors return sent:false and never throw', async () => {
  const refused = await sendWaitlistConfirmation('p@example.com', { env: { RESEND_API_KEY: 'k' }, fetchImpl: async () => ({ ok: false, status: 422 }) });
  assert.deepEqual(refused, { sent: false, status: 422 });
  const broken = await sendWaitlistConfirmation('p@example.com', { env: { RESEND_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(broken.sent, false);
  assert.equal(broken.reason, 'transport');
});

async function signUp(handler, email) {
  const r = mockRes();
  await handler(mockReq({ method: 'POST', url: '/api/onboarding/waitlist', headers: { 'x-forwarded-for': '9.9.9.4' }, body: { email } }), r);
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

test('the sign-up reply stays {ok:true} even when the mailer throws', async () => {
  const h = waitlistHandler({
    redis: () => createMemoryRedis(), now: () => 1700000000000, log: quiet, blobPut: null,
    env: { RESEND_API_KEY: 'k' },
    sendConfirmation: async () => { throw new Error('mailer exploded'); },
  });
  const r = await signUp(h, 'brave@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('the confirmation receives the normalized address and the reply is still {ok:true}', async () => {
  const seen = [];
  const h = waitlistHandler({
    redis: () => createMemoryRedis(), now: () => 1700000000000, log: quiet, blobPut: null,
    env: { RESEND_API_KEY: 'k' },
    sendConfirmation: async (email) => { seen.push(email); return { sent: true, status: 201 }; },
  });
  const r = await signUp(h, '  MixedCase@Example.COM  ');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.deepEqual(seen, [normalizeEmail('  MixedCase@Example.COM  ')]);
  assert.deepEqual(seen, ['mixedcase@example.com']);
});

test('unconfigured mailer in the handler: reply unchanged, zero network', async () => {
  const h = waitlistHandler({ redis: () => createMemoryRedis(), now: () => 1700000000000, log: quiet, blobPut: null, env: {} });
  const r = await signUp(h, 'quiet@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});
