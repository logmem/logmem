import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCESS_DENIED_PATH,
  isMembershipDenial,
  isSignInRequired,
  safeReturnTo,
  spacePath,
  validSpaceId,
} from '../apps/dashboard/lib/server/routes.mjs';

test('space routes stay under /space and reject /app', () => {
  assert.equal(spacePath('abc123', 'today'), '/space/abc123/today');
  assert.equal(spacePath('legacy', 'access'), '/space/legacy/access');
  assert.equal(safeReturnTo('/space/team-1/schedule'), '/space/team-1/schedule');
  assert.equal(safeReturnTo('/select-space'), '/select-space');
  assert.equal(safeReturnTo('/app'), '/select-space');
  assert.equal(safeReturnTo('/app/abc123/today'), '/select-space');
  assert.equal(safeReturnTo('https://evil.example/space/abc/today'), '/select-space');
  assert.equal(safeReturnTo('//evil.example'), '/select-space');
  assert.equal(safeReturnTo('/space/abc/../today'), '/select-space');
  assert.equal(safeReturnTo('/space/abc/secrets'), '/select-space');
  assert.equal(validSpaceId('..'), false);
  assert.equal(validSpaceId('Work'), false);
  assert.equal(ACCESS_DENIED_PATH, '/space/denied');
});

test('membership and role denials are not treated as a missing page signal', () => {
  assert.equal(isMembershipDenial({ code: 'not_found', status: 404 }), true);
  assert.equal(isMembershipDenial({ code: 'forbidden', status: 403 }), true);
  assert.equal(isMembershipDenial({ code: 'customer_dashboard_disabled', status: 503 }), false);
  assert.equal(isMembershipDenial({ code: 'unauthorized_credential_override', status: 403 }), false);
  assert.equal(isMembershipDenial(new Error('not_found')), false);
  assert.equal(isSignInRequired({ code: 'sign_in_required', status: 401 }), true);
  assert.equal(isSignInRequired({ code: 'not_found', status: 404 }), false);
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

test('dashboard screens check access and do not carry internal sample paths', () => {
  const root = 'apps/dashboard';
  const files = walk(root);
  const page = files.filter((path) => /\/space\/\[space\]\/[^/]+\/page\.tsx$/.test(path));
  assert.deepEqual(
    page.map((path) => path.split('/').slice(-2, -1)[0]).sort(),
    ['access', 'activity', 'agents', 'inbox', 'schedule', 'today', 'work'],
  );
  for (const path of page) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /requireSpace\(/, `${path} checks access`);
  }
  const banned = ['madez', 'michaelshaw', 'clawd', '407b953', 'gemini-app', 'llms-full', "href: '/app", 'href="/app', '`/app/', "notFound("];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const word of banned) {
      assert.equal(source.includes(word), false, `${path} contains ${word}`);
    }
  }
});
