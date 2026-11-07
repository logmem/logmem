// Planned-endpoint contracts (phase 5 of the admin plan): fixtures, status reading, whitelist, no dead links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENDPOINTS, ENDPOINT_KEYS, interpret } from '../public/app/endpoint-model.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/endpoints/${n}.json`, import.meta.url), 'utf8'));
const src = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');

test('four planned screens are registered at the planned urls', () => {
  assert.deepEqual(ENDPOINT_KEYS.sort(), ['integrations', 'platform', 'sessions', 'usage']);
  assert.equal(ENDPOINTS.integrations.url, '/api/integrations');
  assert.equal(ENDPOINTS.usage.url, '/api/usage');
});
test('integrations fixture: known fields kept, odd values become safe defaults', () => {
  const r = interpret('integrations', 200, fx('integrations'));
  assert.equal(r.ok, true);
  const [clerk, redis, odd] = r.data.integrations;
  assert.deepEqual([clerk.name, clerk.status, clerk.lastError], ['Clerk', 'degraded', 'Development instance']);
  assert.equal(redis.lastError, null);
  assert.deepEqual([odd.status, odd.checkedAt], ['unknown', null]);
});
test('usage fixture: numbers only when they are numbers', () => {
  const r = interpret('usage', 200, fx('usage'));
  assert.equal(r.data.plan.spacesLimit, 1);
  assert.deepEqual(r.data.usage[1], { metric: 'Entries this month', used: null, limit: null });
});
test('sessions and platform fixtures', () => {
  const s = interpret('sessions', 200, fx('sessions')).data.sessions;
  assert.deepEqual([s[0].device, s[0].current, s[1].device, s[1].lastSeen], ['Safari on iPhone', true, 'Unknown device', null]);
  const w = interpret('platform', 200, fx('platform')).data.workspaces;
  assert.deepEqual([w[0].spaces, w[1].name, w[1].spaces], [2, 'Workspace', null]);
});
test('a secret, token, key, email or address in a reply never reaches the data', () => {
  for (const k of ENDPOINT_KEYS) {
    const out = JSON.stringify(interpret(k, 200, fx(k)).data);
    for (const bad of ['SHOULD_NEVER_SHOW', 'sk_live', 'api_key', 'token', 'stripe', 'billing_email', 'x@example.com', '203.0.113.9']) assert.ok(!out.includes(bad), `${k} leaked ${bad}`);
  }
});
test('404, 405 and 501 mean not built yet, not a failure', () => {
  for (const code of [404, 405, 501]) {
    const r = interpret('integrations', code, null);
    assert.deepEqual([r.ok, r.available, r.error], [false, false, null]);
  }
});
test('401, 403 and 5xx give a plain error and safe defaults', () => {
  for (const code of [401, 403, 500, 502, 503]) {
    const r = interpret('sessions', code, { error: 'not_found' });
    assert.equal(r.ok, false); assert.equal(r.available, true);
    assert.ok(r.error && !r.error.includes('not_found'));
    assert.deepEqual(r.data, { sessions: [] });
  }
});
test('contract: missing version accepted, wrong version rejected', () => {
  assert.equal(interpret('usage', 200, fx('usage')).ok, true);
  assert.equal(interpret('usage', 200, { contract: 1, plan: null }).ok, true);
  const bad = interpret('usage', 200, { contract: 2, plan: { name: 'X' } });
  assert.equal(bad.ok, false); assert.equal(bad.stale, true); assert.match(bad.error, /do not match/);
  assert.equal(interpret('usage', 200, { __contract: 9 }).ok, false);
});
test('garbage bodies never throw and give list defaults', () => {
  for (const k of ENDPOINT_KEYS) for (const body of [null, undefined, 'x', 5, [], { [k]: 'no' }, { integrations: 5, sessions: {}, workspaces: 'a', usage: null }]) {
    const r = interpret(k, 200, body);
    for (const v of Object.values(r.data)) assert.ok(v === null || Array.isArray(v) || typeof v === 'object');
  }
  assert.equal(interpret('nope', 200, {}).ok, false);
});
test('routes are registered, say not available yet, and are not linked from nav', () => {
  assert.match(src('main.js'), /registerEndpointScreens\(pages\)/);
  const v = src('endpoint-view.js');
  assert.match(v, /Not available yet\./);
  assert.doesNotMatch(v, /JSON\.stringify/);
  assert.match(src('data.js'), /export async function readEndpoint/);
  const nav = src('nav-model.js') + src('shell.js');
  for (const k of ENDPOINT_KEYS) assert.ok(!nav.includes(`#/${k}`) && !nav.includes(`['${k}'`), `${k} must not be linked yet`);
});
