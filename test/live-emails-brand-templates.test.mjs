// The three emails the live app sends must use the brand templates, so the
// copy and the look live in one place (src/email/templates.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitlistInviteEmail, workspaceInviteEmail } from '../src/http/resend.mjs';
import { sendWaitlistConfirmation } from '../src/http/waitlist-email.mjs';
import { waitlistConfirmation, waitlistInvite, workspaceInvite } from '../src/email/templates.mjs';

test('waitlist invite uses the brand template and keeps the recipient', () => {
  const mail = waitlistInviteEmail('person@example.com', { origin: 'https://logmem.si' });
  const link = 'https://logmem.si/app?setup=managed&signin=1';
  assert.deepEqual(mail, { to: 'person@example.com', ...waitlistInvite({ link }) });
  assert.match(mail.html, /lm-btn/);
  assert.ok(mail.text.includes(link));
});

test('workspace invite uses the brand template and escapes the workspace name', () => {
  const link = 'https://logmem.si/app?invite=abc';
  const mail = workspaceInviteEmail('person@example.com', link, { workspaceName: '<b>Acme</b>' });
  assert.deepEqual(mail, { to: 'person@example.com', ...workspaceInvite({ workspaceName: '<b>Acme</b>', link }) });
  assert.ok(!mail.html.includes('<b>Acme</b>'));
  assert.ok(mail.text.includes(link));
});

test('waitlist confirmation sends the brand template body', async () => {
  let body;
  const result = await sendWaitlistConfirmation('person@example.com', {
    env: { RESEND_API_KEY: 'test-key' },
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200 }; },
  });
  const expected = waitlistConfirmation({ email: 'person@example.com' });
  assert.deepEqual(result, { sent: true, status: 200 });
  assert.equal(body.subject, expected.subject);
  assert.equal(body.html, expected.html);
  assert.equal(body.text, expected.text);
  assert.deepEqual(body.to, ['person@example.com']);
});
