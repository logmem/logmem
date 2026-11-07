// Operator pages say what they can change (phase 4 of the admin plan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SETTINGS_NOTE, AUDIT_NOTE, INVITE_RISK, inviteAllLabel, inviteAllQuestion } from '../public/app/admin-notes-model.js';

const src = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');
const views = src('views.js');

test('notes are plain short sentences without dashes or semicolons', () => {
  for (const t of [SETTINGS_NOTE, AUDIT_NOTE, INVITE_RISK, inviteAllQuestion(3)]) {
    for (const sentence of t.split(/(?<=[.?!])\s+/)) assert.ok(sentence.split(/\s+/).length <= 25, sentence);
    assert.ok(!/[—;]/.test(t), t);
  }
});
test('bulk invite question names the count and says it cannot be undone', () => {
  assert.match(inviteAllQuestion(1), /1 person/);
  assert.match(inviteAllQuestion(5), /5 people/);
  assert.match(inviteAllQuestion(5), /cannot be undone/);
  assert.equal(inviteAllLabel(4), 'Invite all 4 not invited');
});
test('Settings and Audit show the view-only strip; Health does not', () => {
  assert.match(views, /viewOnlyNote\(SETTINGS_NOTE\)/);
  assert.match(views, /route === 'audit' \? viewOnlyNote\(AUDIT_NOTE\)/);
});
test('Waitlist explains the risk and no longer uses a native confirm dialog', () => {
  assert.match(views, /riskNote\(INVITE_RISK\)/);
  assert.match(views, /inviteAllConfirm\(/);
  assert.doesNotMatch(views, /window\.confirm\(`Invite/);
  assert.match(views, /drawWaitlist\(\);\n\};/, 'waitlist renders through its redraw function');
});
test('bulk invite sends at most 200 and only after the second press', () => {
  assert.match(views, /onSend: \(e\) => invite\(e, pending\.slice\(0, 200\)\)/);
  assert.match(views, /btn\(inviteAllLabel\(pending\.length\), 'primary', \(\) => \{ confirming = true; drawWaitlist\(\); \}\)/);
});
test('confirm buttons keep 44px targets', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.lmx-confirm \.lm-btn\{min-height:44px\}/);
});
