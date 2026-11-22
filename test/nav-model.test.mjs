// Role-gated More links (phase 1 of the admin plan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moreGroups } from '../public/app/nav-model.js';
import { ADMIN, PRIMARY_NAV, WORKSPACE_LINKS } from '../public/app/nav-model.js';

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

test('Activity is a primary nav item right after Inbox, and Brief replaces Today', () => {
  const nav = PRIMARY_NAV.map((n) => n[0]);
  assert.equal(nav[0], 'home');
  assert.equal(PRIMARY_NAV[0][1], 'Brief');
  assert.equal(nav.indexOf('activity'), nav.indexOf('queue') + 1);
  assert.ok(!PRIMARY_NAV.some((n) => n[1] === 'Today'));
});
test('Activity is not an admin link and leads the More workspace group for the phone', () => {
  assert.ok(!ADMIN.some((n) => n[0] === 'activity'));
  assert.equal(WORKSPACE_LINKS[0][0], 'activity');
});
test('every viewer sees Activity: operators and customers of every role', () => {
  const has = (g) => g.workspace.some((n) => n[0] === 'activity');
  assert.ok(has(moreGroups({ customer: false }, ADMIN)));
  for (const role of ['owner', 'admin', 'member', 'viewer', undefined]) assert.ok(has(moreGroups({ customer: true, role }, ADMIN)), `${role} misses Activity`);
});
test('shell uses the shared primary nav and keeps five phone tabs', async () => {
  const s = readFileSync(new URL('../public/app/shell.js', import.meta.url), 'utf8');
  assert.match(s, /export const NAV = PRIMARY_NAV;/);
  const phone = /export const PHONE_NAV = (\[.*\]);/.exec(s);
  assert.ok(phone);
  const tabs = JSON.parse(phone[1].replace(/'/g, '"'));
  assert.equal(tabs.length, 5);
  assert.deepEqual(tabs.map((t) => t[1]), ['Brief', 'Work', 'Inbox', 'Agents', 'More']);
  assert.ok(!PRIMARY_NAV.some((n) => n[1] === 'Team'));
});
