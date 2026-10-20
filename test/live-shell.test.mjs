// Live app shell (docs/superpowers/specs/2026-10-19-logmem-live-app-design.md): static checks on the
// page, the manifest and the client. The interactive flows were checked in a browser at 375, 768 and 1280px.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");

test("app page: loads app.css and the manifest, and the root is not a live region", () => {
  const html = read("app.html");
  assert.match(html, /<link rel="stylesheet" href="\/app.css">/);
  assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(html, /viewport-fit=cover/);
  assert.doesNotMatch(html, /id="root"[^>]*aria-live/, "live re-renders must not make a screen reader read the whole page");
});

test("manifest: installs to a phone home screen and opens on Home", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/app#/home");
  assert.ok(m.icons.length >= 1);
});

test("client: pulses /api/pulse, waits while you type, and every write sends its intent header", () => {
  const js = read("app.js");
  assert.match(js, /\/api\/pulse\?space=/);
  assert.match(js, /function typing\(\)/);
  assert.match(js, /showPill\(\)/);
  assert.match(js, /document\.hidden \? 30000 : 4000/, "4 s while visible, 30 s while hidden");
  assert.match(js, /Math\.min\(60000/, "backs off to 60 s when offline");
  assert.match(js, /postJSON\('\/api\/' \+ op, 'work'/);
  assert.match(js, /postJSON\('\/api\/tasks', 'blockers'/);
  assert.match(js, /'X-LogMem-Intent': intent/);
});

test("layout: phone tab bar, tablet icon rail and a wide pinned panel", () => {
  const css = read("app.css");
  assert.match(css, /@media \(max-width:639px\)\{[^]*\.lmx-tabs\{display:flex/);
  assert.match(css, /@media \(max-width:1023px\)\{[^]*grid-template-columns:64px/);
  assert.match(css, /@media \(min-width:1440px\)\{[^]*lmx-pinned/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test("views: Plans, Jobs board, Agents and Log replace the old pages; one place per question", () => {
  const js = read("app.js");
  for (const v of ["pages.plan =", "pages.jobs =", "pages.agents =", "pages.log =", "pages.recall =", "pages.job ="]) assert.ok(js.includes(v), v);
  assert.match(js, /var BOARD = \[\['open', 'Open'\], \['active', 'Active'\], \['blocked', 'Blocked'\], \['done', 'Done, last 7 days'\]\]/);
  assert.equal((js.match(/^    (log|jobs|plan|channels|recall|overview|decisions|blockers): function/gm) || []).length, 0, "old page functions are gone");
  assert.match(js, /d\.open_asks/, "the job panel shows decisions the server says are open");
});
