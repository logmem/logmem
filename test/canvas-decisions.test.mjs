import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const app = (f) => read('public/app/' + f);

test('decisions page exists, is registered and reuses decide()', () => {
  const v = app('decisions-view.js');
  assert.match(v, /export function splitDecisions/);
  assert.match(v, /pages\.decisions\s*=/);
  assert.match(v, /load\('decisions'\)/);
  assert.match(v, /decide\(e, a, 'approve'\)/);
  assert.match(v, /decide\(e, a, 'reject'\)/);
  assert.match(v, /decide\(e, a, 'defer'\)/);
  for (const s of ['Open', 'Answered', 'Deferred']) assert.match(v, new RegExp("section\\('" + s.toLowerCase() + "', '" + s + "'"));
  assert.doesNotMatch(v, /postJSON|fetch\(/);
  assert.match(app('main.js'), /registerDecisions\(pages, ok\)/);
});
test('splitDecisions puts deferred asks in their own section', async () => {
  const src = app('decisions-view.js').match(/export function splitDecisions[\s\S]*?\n}\n/)[0].replace('export ', '');
  const split = new Function(src + '; return splitDecisions;')();
  const r = split({ waiting: [{ trail: 'a' }, { trail: 'b', deferred: { at: 1 } }], decided: [{ ask: { trail: 'c' }, answer: {} }, null] });
  assert.deepEqual([r.open.length, r.deferred.length, r.answered.length], [1, 1, 1]);
  assert.deepEqual(split(null), { open: [], deferred: [], answered: [] });
});
test('decisions is linked from Inbox and More, not from top-level nav', () => {
  assert.match(app('interactions.js'), /href="#\/decisions"/);
  assert.match(app('views.js'), /\['decisions', 'Decisions', 'decisions'\]/);
  const shell = app('shell.js');
  assert.doesNotMatch(shell.match(/export const NAV = .*/)[0], /decisions/);
  assert.doesNotMatch(shell.match(/export const PHONE_NAV = .*/)[0], /decisions/);
});
test('footer tagline and Check in tree are gone', () => {
  assert.doesNotMatch(app('shell.js'), /lmx-app-tagline/);
  assert.doesNotMatch(app('today-components.js'), /Check in|taskTree/);
  assert.doesNotMatch(app('views.js'), /taskTree/);
});
test('settings display-only rows say Planned', () => {
  assert.match(app('views.js'), /lmx-rochip[^`]*lm-badge lm-badge--info">Planned/);
});
test('no Snooze, Reassign button, Mark done or Pause all controls exist in views', () => {
  for (const f of ['views.js', 'cards.js', 'shell.js', 'decisions-view.js']) assert.doesNotMatch(app(f), />\s*(Snooze|Mark done|Pause all agents)\s*</i);
});
test('canvas-decisions css is appended and the adminbar rule stays last no-space media', () => {
  const css = read('public/app.css');
  assert.match(css, /\/\* canvas-decisions \*\//);
  assert.match(css.slice(css.indexOf('/* canvas-decisions */')), /@media \(max-width: 639px\)/);
  assert.doesNotMatch(css, /\.lmx-app-tagline/);
});
