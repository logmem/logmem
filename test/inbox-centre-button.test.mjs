import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../public/app/shell.js', import.meta.url), 'utf8');
test('Inbox is the centre phone tab', () => {
  const m = shell.match(/PHONE_NAV = \[(.*)\];/);
  assert.ok(m);
  assert.match(m[1].split('],')[2], /queue/);
});
test('the centre phone tab is a filled round button', () => {
  assert.match(css, /canvas-inbox-centre/);
  assert.match(css, /\.lmx-tabs a:nth-child\(3\)::before\{[^}]*border-radius:50%/);
});
