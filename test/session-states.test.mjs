// Session and Clerk states (phase 3 of the admin plan). Copy comes from the canvas SessionStates board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTICE, noticeFor, notice, noticeLine, isDevInstance, DEV_INSTANCE } from '../public/app/session-states.js';

const src = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');

test('each failure maps to its own notice', () => {
  assert.equal(noticeFor({ status: 401 }), 'expired');
  assert.equal(noticeFor({ status: 401, intent: 'decide' }), 'approval');
  assert.equal(noticeFor({ status: 403 }), 'accessChanged');
  assert.equal(noticeFor({ status: 404 }), 'gone');
  assert.equal(noticeFor({ status: 503 }), 'unreachable');
  assert.equal(noticeFor({ status: 403, code: 'account_suspended' }), 'suspended');
  assert.equal(noticeFor({ status: 401, code: 'Suspended' }), 'suspended');
});
test('raw server codes never reach the person', () => {
  for (const code of ['not_found', 'forbidden', 'unauthorized', 'status 401']) {
    const line = noticeLine({ status: 403, code });
    assert.ok(!line.includes(code), code);
  }
});
test('every notice has a title, a body and an action, in short sentences', () => {
  for (const [k, n] of Object.entries(NOTICE)) {
    assert.ok(n.title && n.body && n.action, k);
    for (const sentence of (n.title + ' ' + n.body).split(/(?<=[.?!])\s+/)) assert.ok(sentence.split(/\s+/).length <= 25, `${k}: ${sentence}`);
    assert.ok(!/[—;]/.test(n.title + n.body), `${k}: no dashes or semicolons`);
  }
});
test('the approval notice says nothing ran and the ask still waits', () => {
  assert.match(notice({ status: 401, intent: 'decide' }).body, /Nothing ran/);
  assert.match(notice({ status: 401, intent: 'decide' }).body, /still waiting/);
});
test('expired notice does not promise more than the server keeps', () => {
  assert.doesNotMatch(NOTICE.expired.body, /nothing on this page was lost/i);
  assert.match(NOTICE.expired.body, /already saved/i);
});
test('dev instance warning shows only for pk_test keys', () => {
  assert.equal(isDevInstance({ publishableKey: 'pk_test_abc' }), true);
  assert.equal(isDevInstance({ publishableKey: 'pk_live_abc' }), false);
  assert.equal(isDevInstance(null), false);
  assert.match(DEV_INSTANCE.title, /development instance/);
});
test('core, main and account use the notices', () => {
  const core = src('core.js');
  assert.match(core, /onSignedOut\(notice\(\{status:401,code:value\.error\}\)\)/);
  assert.match(core, /intent\}\)\)/, 'postJSON passes its intent so a decision gets the approval notice');
  assert.doesNotMatch(core, /value\.error\|\|'Your sign-in expired\.'/);
  assert.match(src('main.js'), /login\(NOTICE\.otherTab\)/);
  const acct = src('account.js');
  assert.match(acct, /Pick up where you left off\./);
  assert.match(acct, /Signing in does not connect or launch an agent\./);
  assert.match(acct, /No account yet\? The same button creates one\./);
  assert.match(acct, /state\.clerkDev/);
});
test('keep-alive code from PR 233 is untouched', () => {
  assert.match(src('session-keepalive.js'), /skipCache:true/);
});
