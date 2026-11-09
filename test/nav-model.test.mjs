// Role-gated More links (phase 1 of the admin plan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moreGroups } from '../public/app/nav-model.js';
import { ADMIN } from '../public/app/nav-model.js';

const ids = (g) => g.admin.map((n) => n[0]);
test('operator keeps every admin link', () => {
  assert.deepEqual(ids(moreGroups({ customer: false }, ADMIN)), ADMIN.map((n) => n[0]));
});
test('customer never sees operator pages', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer', undefined]) {
    const got = ids(moreGroups({ customer: true, role }, ADMIN));
    for (const bad of ['audit', 'waitlist', 'activity', 'keys', 'connections', 'settings']) assert.ok(!got.includes(bad), `${role} sees ${bad}`);
  }
});
test('only workspace managers keep Agent access', () => {
  assert.deepEqual(ids(moreGroups({ customer: true, role: 'owner' }, ADMIN)), ['access']);
  assert.deepEqual(ids(moreGroups({ customer: true, role: 'admin' }, ADMIN)), ['access']);
  assert.deepEqual(ids(moreGroups({ customer: true, role: 'member' }, ADMIN)), []);
  assert.deepEqual(ids(moreGroups({ customer: true, role: 'viewer' }, ADMIN)), []);
});
test('customer gets a You group with Settings at #/account; operator does not', () => {
  assert.deepEqual(moreGroups({ customer: true, role: 'viewer' }, ADMIN).you[0].slice(0, 2), ['account', 'Settings']);
  assert.equal(moreGroups({ customer: false }, ADMIN).you.length, 0);
});
test('More page uses the model', () => {
  const v = readFileSync(new URL('../public/app/views.js', import.meta.url), 'utf8');
  assert.match(v, /moreGroups\(/);
  assert.doesNotMatch(v, /\$\{ADMIN\.map\(link\)\}/);
});
