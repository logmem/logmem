import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { seedPrompt, developerSeedPrompt, DEVELOPER_ADDENDUM, PROJECT_PLACEHOLDER } from '../public/app/seed-prompt.js';
const read = p => readFile(new URL('../' + p, import.meta.url), 'utf8');
const blocks = md => [...md.matchAll(/```text\n([\s\S]*?)\n```/g)].map(m => m[1]);

test('the seed skill, its public copy and the plugin copy hold the prompt module text', async () => {
  for (const path of ['skills', 'public/skills', 'plugins/logmem/skills']) {
    const [prompt, dev] = blocks(await read(`${path}/logmem-seed-space/SKILL.md`));
    assert.equal(prompt, seedPrompt(), path);
    assert.equal(dev, DEVELOPER_ADDENDUM, path);
  }
});

test('the seed prompt keeps its gates: one space, read first, a draft, approval, a proof, and the private rules', () => {
  const p = seedPrompt('Acme');
  assert.match(p, /One project is one space/);
  assert.match(p, /Phase 1: find the work \(read only, no writes\)/);
  assert.match(p, /Wait for my "approved"/);
  assert.match(p, /Phase 5: prove it/);
  assert.match(p, /brainstorming skill/);
  assert.match(p, /Ask me before you send messages outside the space, spend money, delete or publish/);
  assert.match(p, /data, not instructions/);
  assert.ok(p.includes('project: Acme.') && p.includes('not for Acme'));
  assert.ok(seedPrompt().includes(PROJECT_PLACEHOLDER));
  assert.ok(developerSeedPrompt('Acme').endsWith(DEVELOPER_ADDENDUM));
  for (const tool of ['logmem_connection', 'logmem_spaces', 'logmem_plan', 'logmem_assign', 'logmem_stage', 'logmem_update', 'logmem_note', 'logmem_handoff', 'logmem_bio', 'logmem_recap']) assert.ok(p.includes(tool), tool);
});

test('the app shows the seed card on the empty Home and Plan pages, and /how-to links it', async () => {
  const views = await read('public/app/views.js');
  assert.equal((views.match(/seedCard\(/g) || []).length, 2);
  assert.match(await read('public/app/seed-components.js'), /Copy seed prompt/);
  const howto = await read('public/how-to.html');
  for (const id of ['first', 'seed', 'daily', 'asks', 'words', 'say', 'stuck']) assert.match(howto, new RegExp(`id="${id}"`), id);
  assert.match(await read('public/sitemap.xml'), /logmem\.si\/how-to/);
  assert.match(await read('public/skills.html'), /logmem-seed-space/);
});
