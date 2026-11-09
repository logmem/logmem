// One Agent access screen replaces /keys, /connections and the Settings agents list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeAccess, canManageAccess, createBody, validAgent, accessLabel, revokeQuestion, disconnectQuestion, KEY_HELP, NOT_MANAGER } from '../public/app/access-model.js';
import { ADMIN } from '../public/app/nav-model.js';

const app = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');
const pub = (f) => new URL('../public/' + f, import.meta.url);

const OPERATOR = { keys: [{ id: 'k1', agent: 'muse', space: 'madez', label: 'Muse vault', scope: 'read', created_at: 1794000000000, key: 'lm_SHOULD_NEVER_SHOW' }, { id: 'k2', agent: 'codex', space: 'madez' }], spaces: ['madez', 'fieldnotes'], web: [{ fid: 'f1', app: 'Gemini', agent: 'gemini', space: 'madez', last_used: 1794000000 }] };
const CUSTOMER = { keys: [{ id: 'c1', agent: 'claude', namespace: 'fieldnotes' }], apps: [{ id: 'a1', fid: 'f9', app: 'Claude web', agent: 'claude', last_call_at: 1794000000 }] };

test('operator reply: keys, apps from web, spaces; read-only flag; seconds become ms', () => {
  const d = normalizeAccess(OPERATOR);
  assert.deepEqual(d.keys.map((k) => [k.agent, k.space, k.readOnly]), [['muse', 'madez', true], ['codex', 'madez', false]]);
  assert.deepEqual(d.spaces, ['madez', 'fieldnotes']);
  assert.equal(d.apps[0].app, 'Gemini');
  assert.equal(d.apps[0].lastUsed, 1794000000000);
});
test('customer reply: namespace becomes the space, apps field is read', () => {
  const d = normalizeAccess(CUSTOMER);
  assert.equal(d.keys[0].space, 'fieldnotes');
  assert.deepEqual([d.apps[0].app, d.apps[0].fid, d.apps[0].lastUsed], ['Claude web', 'f9', 1794000000000]);
});
test('a key value never reaches the rows', () => {
  assert.ok(!JSON.stringify(normalizeAccess(OPERATOR)).includes('SHOULD_NEVER_SHOW'));
});
test('garbage replies give empty lists', () => {
  for (const bad of [null, undefined, 'x', 5, [], { keys: 5, apps: 'a', spaces: {} }]) assert.deepEqual(normalizeAccess(bad), { keys: [], apps: [], spaces: [] });
});
test('who may manage', () => {
  assert.equal(canManageAccess({ customer: false }), true);
  assert.equal(canManageAccess({ customer: true, role: 'owner' }), true);
  assert.equal(canManageAccess({ customer: true, role: 'admin' }), true);
  for (const role of ['member', 'viewer', 'contributor', undefined]) assert.equal(canManageAccess({ customer: true, role }), false);
  assert.match(NOT_MANAGER, /owner manages/);
});
test('create body: operator names space, label and access; customer names an agent only', () => {
  assert.deepEqual(createBody({ customer: true, agent: ' codex ', space: 'x', label: 'y', readOnly: true }), { agent: 'codex' });
  assert.deepEqual(createBody({ customer: false, agent: 'muse', space: 'madez', label: ' vault ' }), { agent: 'muse', space: 'madez', label: 'vault' });
  assert.equal(createBody({ customer: false, agent: 'muse', space: 'madez', readOnly: true }).scope, 'read');
  assert.equal(createBody({ customer: false, agent: 'a', space: 's', label: 'x'.repeat(200) }).label.length, 80);
});
test('agent name rule', () => {
  for (const ok of ['muse', 'codex-2', 'a.b_c']) assert.ok(validAgent(ok), ok);
  for (const bad of ['', '1abc', 'Muse', 'a b', '../x']) assert.ok(!validAgent(bad), bad);
});
test('words are short plain sentences without dashes or semicolons', () => {
  for (const t of [KEY_HELP, revokeQuestion('muse'), disconnectQuestion('Gemini'), accessLabel(true)]) {
    for (const s of t.split(/(?<=[.?!])\s+/)) assert.ok(s.split(/\s+/).length <= 25, s);
    assert.ok(!/[—;]/.test(t), t);
  }
});
test('one menu entry replaces Agent keys and Connections', () => {
  const ids = ADMIN.map((n) => n[0]);
  assert.ok(ids.includes('access'));
  assert.ok(!ids.includes('keys') && !ids.includes('connections'));
  assert.deepEqual(ADMIN.find((n) => n[0] === 'access').slice(1, 2), ['Agent access']);
});
test('the old pages are redirects and their scripts are gone', () => {
  for (const f of ['keys.js', 'connections.js', 'utility-shell.js', 'utility-shell.css']) assert.ok(!existsSync(pub(f)), f);
  assert.match(readFileSync(pub('keys.html'), 'utf8'), /http-equiv="refresh" content="0;url=\/app\?operator=1#\/access"/);
  assert.match(readFileSync(pub('connections.html'), 'utf8'), /http-equiv="refresh" content="0;url=\/app#\/access"/);
});
test('the screen is registered, asks in the page, and never prints a stored key', () => {
  assert.match(app('main.js'), /registerAccess\(pages\)/);
  const v = app('access-view.js');
  assert.doesNotMatch(v, /window\.confirm/);
  assert.match(v, /fresh = null/);
  assert.match(v, /postJSON\(URL_, 'agent-keys'/);
  assert.doesNotMatch(v, /localStorage|sessionStorage/);
});
test('the api route and its tests are untouched', () => {
  assert.ok(existsSync(new URL('../api/connections.mjs', import.meta.url)));
  assert.ok(existsSync(new URL('../api/agent-keys.mjs', import.meta.url)));
});
