// Fleet-truth board UI (approach A). Source-text checks on the app files, plus the pure model.
// Every test here fails on the tree before the board existed (the files and hooks are missing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeFact, readBoard, summaryChips, visibleFacts, slotLabel, FRESH_MS, SECTION_DEFS, TAGS } from '../public/app/fleet-truth-model.js';

const app = (f) => readFileSync(new URL('../public/app/' + f, import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../public/ds/components/bundle.css', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-06T18:00:00Z');
const fact = (o = {}) => ({ claim: 'c', status: 'reported', observed_at: '2026-11-06T17:00:00Z', source: 'job:x', ...o });
const board = (o = {}) => ({
  summary: 'fleet-truth midday 2026-11-06T17:00:00Z | P0=launch | top_blocker=waits on approval | infra=degraded',
  board: { schema: 'fleet-truth/v1', refreshed_at: '2026-11-06T17:00:00Z', slot: 'midday', runner: 'agent:grok', trail: 'fleetTruth-20261106-midday', blockers: { items: [fact({ status: 'verified', verified_by: 'probe:x' })] }, ...o },
});

test('new files exist and the route hunk in main.js is small', () => {
  assert.ok(existsSync(new URL('../public/app/fleet-truth-view.js', import.meta.url)));
  assert.ok(existsSync(new URL('../public/app/fleet-truth-model.js', import.meta.url)));
  const main = app('main.js');
  assert.match(main, /import \{ registerFleetTruth \} from '\.\/fleet-truth-view\.js';/);
  assert.equal((main.match(/registerFleetTruth\(pages, ok\);/g) || []).length, 1);
});

test('the view reads through data.js load and never calls api() or a write path', () => {
  const v = app('fleet-truth-view.js');
  assert.match(v, /load\('channels', \{ id \}\)/);
  assert.doesNotMatch(v, /\bapi\(|postJSON|fetch\(|method:\s*'POST'|decide\(/);
  assert.doesNotMatch(v, /<input|<textarea|<form/);
});

test('only the fleet-truth channel is special; other channels keep the old page', () => {
  const v = app('fleet-truth-view.js');
  assert.match(v, /if \(id !== CHANNEL_ID\) return plain\(id\)/);
  assert.equal(app('fleet-truth-model.js').match(/CHANNEL_ID = 'fleet-truth'/).length, 1);
});

test('More lists Fleet truth and no new top-level nav entry appears', () => {
  assert.match(app('views.js'), /\['channels\/fleet-truth', 'Fleet truth', 'eye'\]/);
  const shell = app('shell.js');
  assert.doesNotMatch(shell, /fleet-truth/);
  assert.equal(shell.match(/PHONE_NAV = \[(.*)\];/)[1].split('],').length, 5);
});

test('every icon the board uses exists in the design system bundle', () => {
  for (const t of Object.values(TAGS)) assert.ok(bundle.includes(`data-i="${t.icon}"`), 'missing icon ' + t.icon);
  for (const i of ['eye', 'clock', 'alert']) assert.ok(bundle.includes(`data-i="${i}"`), i);
});

test('CSS is one appended fleet-truth-board block with a spaced phone query', () => {
  const at = css.indexOf('/* fleet-truth-board */');
  assert.ok(at > 0);
  const block = css.slice(at);
  assert.match(block, /@media \(max-width: 639px\)/);
  assert.doesNotMatch(block, /@media \(max-width:639px\)/);
  assert.match(block, /min-height:44px/);
  assert.match(css.slice(css.lastIndexOf('@media (max-width:639px)')), /^@media \(max-width:639px\)\{\.lmx-adminbar a\{display:none\}\}/);
});

test('empty and odd Now payloads give states, not boards', () => {
  assert.equal(readBoard(null).state, 'empty');
  assert.equal(readBoard({}).state, 'empty');
  const odd = readBoard({ doing: 'seeding' });
  assert.equal(odd.state, 'schema');
  assert.equal(odd.schema, 'not recorded');
  assert.equal(readBoard({ board: { schema: 'fleet-truth/v9' } }).schema, 'fleet-truth/v9');
});

test('a board reads in fixed section order, with missing sections kept and counted zero', () => {
  const b = readBoard(board(), NOW);
  assert.equal(b.state, 'ok');
  assert.deepEqual(b.sections.map((s) => s.key), SECTION_DEFS.map((s) => s.key));
  assert.deepEqual(b.sections.map((s) => s.key), ['clock', 'lanes', 'launch', 'blockers', 'infra', 'agents', 'deltas']);
  assert.equal(b.sections.find((s) => s.key === 'clock').present, false);
  assert.equal(b.counts.verified, 1);
  assert.equal(b.total, 1);
  assert.equal(b.slot, 'midday');
  assert.equal(slotLabel('midday'), 'Midday refresh');
});

test('a flat payload and the collector wrapper both read', () => {
  const flat = readBoard({ ...board().board, summary: 's' }, NOW);
  assert.equal(flat.state, 'ok');
});

test('stale marker follows the board window and a missing refresh time; row tags stay as written', () => {
  assert.equal(readBoard(board(), NOW).stale, false);
  assert.equal(readBoard(board(), NOW + FRESH_MS + 3600e3).stale, true);
  const nots = board(); delete nots.board.refreshed_at;
  const b = readBoard(nots, NOW);
  assert.equal(b.stale, true);
  assert.equal(b.sections.find((s) => s.key === 'blockers').facts[0].tag, 'verified');
});

test('fact defaults: unknown tag shows and counts as unknown, missing fields are not invented', () => {
  const f = normalizeFact({ status: 'maybe' });
  assert.equal(f.tag, 'unknown');
  assert.equal(f.oddTag, 'maybe');
  assert.equal(f.claim, 'Claim text missing');
  assert.equal(f.source, '');
  assert.equal(f.observedAt, '');
  assert.equal(normalizeFact(null).tag, 'unknown');
  assert.equal(normalizeFact(fact({ status: 'verified' })).verifiedByMissing, true);
  assert.equal(normalizeFact(fact({ status: 'reported' })).verifiedByMissing, false);
});

test('only https sources become links; secret-looking values are replaced', () => {
  assert.equal(normalizeFact(fact({ source: 'https://git.example/pr/1' })).sourceUrl, 'https://git.example/pr/1');
  assert.equal(normalizeFact(fact({ source: 'http://x.example' })).sourceUrl, '');
  assert.equal(normalizeFact(fact({ source: 'javascript:alert(1)' })).sourceUrl, '');
  const s = normalizeFact(fact({ claim: 'mail a@b.example now' }));
  assert.equal(s.claim, 'Redacted by viewer');
  assert.equal(s.redacted, true);
});

test('summary chips show only the parts the line has', () => {
  assert.deepEqual(summaryChips(board().summary).map((c) => c.label), ['P0', 'Top blocker', 'Infra']);
  assert.deepEqual(summaryChips('fleet-truth manual | infra=ok').map((c) => c.label), ['Infra']);
  assert.deepEqual(summaryChips(''), []);
});

test('tag filter hides rows only from the view, not from the counts', () => {
  const b = readBoard(board({ lanes: { items: [fact({ status: 'stale' })] } }), NOW);
  const all = b.sections.flatMap((s) => s.facts);
  const shown = visibleFacts(all, { verified: true, reported: true, unknown: true, stale: false });
  assert.equal(all.length, 2);
  assert.equal(shown.length, 1);
  assert.equal(b.counts.stale, 1);
});

test('the view has no write controls and uses the shared copy and more menu parts', () => {
  const v = app('fleet-truth-view.js');
  assert.match(v, /moreMenu\(/);
  assert.match(v, /idChip\(/);
  assert.match(v, /aria-pressed=/);
  assert.match(v, /Copy correction text/);
});
