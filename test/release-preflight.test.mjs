import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkReleaseSource } from '../scripts/release-preflight.mjs';

const project = { projectId: 'prj_5XgfTvtCCkCcJX40xpr5sclZKTP8', orgId: 'team_Ot5gPVkUTUhMMKTLfDTcSXZE' };
const remote = 'https://github.com/logmem/logmem.git';
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'logmem-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream');
  const checkout = join(root, 'checkout');
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.name', 'Release Test');
  git(upstream, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(upstream, '.gitignore'), '.vercel/\n');
  writeFileSync(join(upstream, 'site.txt'), 'approved site');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'approved source');
  git(root, 'clone', upstream, checkout);
  git(checkout, 'remote', 'set-url', 'origin', remote);
  git(checkout, 'config', `url.${upstream}.insteadOf`, remote);
  mkdirSync(join(checkout, '.vercel'));
  writeFileSync(join(checkout, '.vercel/project.json'), JSON.stringify(project));
  const sha = git(checkout, 'rev-parse', 'HEAD');
  const check = (options = {}) => checkReleaseSource({ cwd: checkout, approvedSha: sha, approvalRef: 'operator-chat:release-test', ...options });
  return { root, upstream, checkout, sha, check };
}

test('clean approved source passes after a real fetch', (t) => {
  const f = fixture(t);
  const receipt = f.check();
  assert.equal(receipt.sha, f.sha);
  assert.equal(receipt.mainSha, f.sha);
  assert.equal(receipt.projectId, project.projectId);
  assert.equal(receipt.approvalRef, 'operator-chat:release-test');
  assert.equal(receipt.kind, 'source-preflight');
});

test('tracked, staged and untracked source changes fail', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, 'site.txt'), 'old site');
  assert.throws(() => f.check(), /source is not clean/);
  git(f.checkout, 'add', 'site.txt');
  assert.throws(() => f.check(), /source is not clean/);
  git(f.checkout, 'reset', '--hard', 'HEAD');
  writeFileSync(join(f.checkout, 'surprise.html'), 'old page');
  assert.throws(() => f.check(), /source is not clean/);
});

test('a fresh upstream commit makes the checkout stale', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.upstream, 'site.txt'), 'new source');
  git(f.upstream, 'commit', '-am', 'next release');
  assert.throws(() => f.check(), /HEAD does not match current main/);
});

test('a different approved revision fails', (t) => {
  const f = fixture(t);
  assert.throws(() => f.check({ approvedSha: 'a'.repeat(40) }), /HEAD does not match the approved revision/);
});

test('missing approval reference and short revisions fail', (t) => {
  const f = fixture(t);
  assert.throws(() => f.check({ approvalRef: '' }), /approval reference/);
  assert.throws(() => f.check({ approvedSha: f.sha.slice(0, 7) }), /full 40 character/);
});

test('a wrong or missing project link fails', (t) => {
  const f = fixture(t);
  for (const wrong of [{ ...project, projectId: 'other' }, { ...project, orgId: 'other' }]) {
    writeFileSync(join(f.checkout, '.vercel/project.json'), JSON.stringify(wrong));
    assert.throws(() => f.check(), /wrong Vercel project or team/);
  }
  rmSync(join(f.checkout, '.vercel/project.json'));
  assert.throws(() => f.check(), /read the Vercel project link/);
});

test('wrong repository and subdirectory invocation fail', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, 'subdir'));
  assert.throws(() => f.check({ cwd: join(f.checkout, 'subdir') }), /repository root/);
  git(f.checkout, 'remote', 'set-url', 'origin', 'https://github.com/other/logmem.git');
  assert.throws(() => f.check(), /wrong repository/);
});

test('fetch failure does not accept a cached main ref', (t) => {
  const f = fixture(t);
  rmSync(f.upstream, { recursive: true, force: true });
  assert.throws(() => f.check(), /fetch current main/);
});

test('the CLI emits one receipt on success and exits nonzero on rejection', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('../scripts/release-preflight.mjs', import.meta.url));
  const args = [script, '--approved-sha', f.sha, '--approval-ref', 'operator-chat:release-test'];
  const passed = spawnSync(process.execPath, args, { cwd: f.checkout, encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).sha, f.sha);
  writeFileSync(join(f.checkout, 'site.txt'), 'unapproved change');
  const rejected = spawnSync(process.execPath, args, { cwd: f.checkout, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /source is not clean/);
});
