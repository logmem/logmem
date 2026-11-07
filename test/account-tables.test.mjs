// Settings tables (phase 2 of the admin plan): pure row models plus wiring checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spaceRows, spaceAccessSummary, memberRows, inviteRows, roleLabel, RENAME_REASON } from '../public/app/account-model.js';

const src = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');
const SPACES = [{ id: 'sp_1', namespace: 'fieldnotes', name: 'Field Notes', workspaceId: 'w1' }, { id: 'sp_2', namespace: 'ops', name: 'Ops', workspaceId: 'w1', sampleTemplate: 'trades' }, { id: 'sp_3', namespace: 'other', name: 'Other', workspaceId: 'w2' }];

test('spaceRows keeps only this workspace and shows name, slug and id', () => {
  const r = spaceRows(SPACES, 'w1');
  assert.deepEqual(r.map((x) => [x.name, x.slug, x.id]), [['Field Notes', 'fieldnotes', 'sp_1'], ['Ops', 'ops', 'sp_2']]);
  assert.equal(r[1].sample, true);
  assert.equal(r[0].members, null, 'unknown until members load');
});
test('spaceRows counts people with access once members load', () => {
  const r = spaceRows(SPACES, 'w1', [{ spaces: { sp_1: {} } }, { spaces: { sp_1: {}, sp_2: {} } }, {}]);
  assert.deepEqual(r.map((x) => x.members), [2, 1]);
});
test('row builders survive missing and wrong-type input', () => {
  for (const bad of [null, undefined, 'x', 5, {}]) {
    assert.deepEqual(spaceRows(bad, 'w1'), []);
    assert.deepEqual(memberRows(bad, { userId: 'u', owner: false, totalSpaces: 0 }), []);
    assert.deepEqual(inviteRows(bad), []);
  }
  assert.equal(roleLabel(undefined), 'Unknown');
});
test('access summary words', () => {
  assert.equal(spaceAccessSummary({ spaces: {} }, 2), 'No spaces');
  assert.equal(spaceAccessSummary({ spaces: { a: {} } }, 2), '1 of 2 spaces');
  assert.equal(spaceAccessSummary({ spaces: { a: {}, b: {} } }, 2), 'All spaces');
  assert.equal(spaceAccessSummary({}, 0), 'No spaces yet');
});
test('memberRows marks you and locks owners from non-owners', () => {
  const m = [{ userId: 'u1', role: 'owner', label: 'a@x.co', spaces: {} }, { userId: 'u2', role: 'member', spaces: { s: {} } }];
  const asAdmin = memberRows(m, { userId: 'u2', owner: false, totalSpaces: 1 });
  assert.equal(asAdmin[0].locked, true);
  assert.equal(asAdmin[1].who, 'You');
  assert.equal(asAdmin[1].roleText, 'Editor');
  assert.equal(memberRows(m, { userId: 'u2', owner: true, totalSpaces: 1 })[0].locked, false);
});
test('Rename stays disabled with a stated reason', () => {
  assert.match(RENAME_REASON, /not available/i);
  const t = src('account-tables.js');
  assert.match(t, /Rename<\/button>/);
  assert.match(t, /disabled title=\$\{RENAME_REASON\}/);
});
test('Settings uses the tables and keeps every existing action', () => {
  const a = src('account.js');
  for (const act of ["action:'set'", "action:'remove'", "action:'revoke-invitation'"]) assert.ok(a.includes(act), act);
  assert.match(a, /spacesTable\(/);
  assert.match(a, /membersTable\(/);
  assert.match(a, /href="#\/access"/, 'agent keys and apps live on the Agent access screen');
  assert.doesNotMatch(a, /connection-list|connectAgent/);
  assert.match(a, /id="spaces-table"/);
  assert.doesNotMatch(a, /createElement\('details'\)/, 'old DOM-built member list is gone');
});
test('tables collapse to labelled stacks at phone width with 44px targets', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /admin-phase2/);
  assert.match(css, /\.lmx-table td\[data-label\]::before/);
  assert.match(css, /\.lmx-table \.lm-btn,\.lmx-idchip\{min-height:44px\}/);
});
