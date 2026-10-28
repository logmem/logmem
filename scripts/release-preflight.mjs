import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PROJECT = 'prj_5XgfTvtCCkCcJX40xpr5sclZKTP8';
const TEAM = 'team_Ot5gPVkUTUhMMKTLfDTcSXZE';
const REPOSITORIES = new Set([
  'https://github.com/logmem/logmem.git', 'https://github.com/logmem/logmem',
  'git@github.com:logmem/logmem.git', 'ssh://git@github.com/logmem/logmem.git',
]);

/** Check source only. An approval reference is not independent proof of approval. */
export function checkReleaseSource({ cwd = process.cwd(), approvedSha, approvalRef } = {}) {
  if (!/^[a-f0-9]{40}$/.test(approvedSha || '')) throw new Error('Use the full 40 character approved revision');
  if (typeof approvalRef !== 'string' || !approvalRef.trim() || approvalRef.length > 500 || /[\r\n]/.test(approvalRef)) {
    throw new Error('Provide one approval reference, at most 500 characters');
  }
  const run = (args, error) => {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Do not echo Git stderr. It can contain credential-bearing remote URLs.
      throw new Error(error);
    }
  };
  const root = run(['rev-parse', '--show-toplevel'], 'Cannot read the repository root');
  if (realpathSync(root) !== realpathSync(cwd)) throw new Error('Run the preflight from the repository root');
  const remote = run(['config', '--get', 'remote.origin.url'], 'Cannot read the origin repository');
  if (!REPOSITORIES.has(remote)) throw new Error('The checkout uses the wrong repository');
  let project;
  try { project = JSON.parse(readFileSync(resolve(cwd, '.vercel/project.json'), 'utf8')); }
  catch { throw new Error('Cannot read the Vercel project link'); }
  if (project.projectId !== PROJECT || project.orgId !== TEAM) throw new Error('The checkout links to the wrong Vercel project or team');
  const clean = () => {
    if (run(['status', '--porcelain', '--untracked-files=all'], 'Cannot inspect source changes')) {
      throw new Error('The release source is not clean');
    }
  };
  clean();
  run(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'Cannot fetch current main');
  const head = run(['rev-parse', 'HEAD'], 'Cannot read HEAD');
  const main = run(['rev-parse', 'refs/remotes/origin/main'], 'Cannot read fetched main');
  if (head !== approvedSha) throw new Error('HEAD does not match the approved revision');
  if (head !== main) throw new Error('HEAD does not match current main');
  clean();
  return {
    kind: 'source-preflight', checkedAt: new Date().toISOString(), sha: head, mainSha: main,
    repository: 'logmem/logmem', projectId: PROJECT, teamId: TEAM, approvalRef: approvalRef.trim(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { 'approved-sha': { type: 'string' }, 'approval-ref': { type: 'string' } } });
    console.log(JSON.stringify(checkReleaseSource({ approvedSha: values['approved-sha'], approvalRef: values['approval-ref'] })));
  } catch (error) {
    console.error(`Release source rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
