// Live app shell (docs/superpowers/specs/2026-10-19-logmem-live-app-design.md): static checks on the
// page, the manifest and the client. The interactive flows were checked in a browser at 375, 768 and 1280px.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
// The client is ES modules under public/app; checks read all of them together.
const appJs = () => fs.readdirSync(new URL("../public/app/", import.meta.url)).filter((f) => f.endsWith(".js")).map((f) => read("app/" + f)).join("\n");

test("app page: loads app.css and the manifest, and the root is not a live region", () => {
  const html = read("app.html");
  assert.match(html, /<link rel="stylesheet" href="\/app.css">/);
  assert.match(html, /<script type="module" src="\/app\/main.js"><\/script>/);
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
  const js = appJs();
  assert.match(js, /\/api\/pulse\?space=/);
  assert.match(js, /const typing = \(\) =>/);
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
  const js = appJs();
  for (const v of ["pages.plan =", "pages.jobs =", "pages.agents =", "pages.log =", "pages.recall =", "pages.job =", "pages.lanes =", "pages.home ="]) assert.ok(js.includes(v), v);
  assert.match(js, /const BOARD = \[\['open', 'Open'\], \['active', 'Active'\], \['blocked', 'Blocked'\], \['done', 'Done, last 7 days'\]\]/);
  assert.match(js, /d\.open_asks/, "the job panel shows decisions the server says are open");
});

test("hardening: no raw HTML sinks in the client; every view is a lit-html template", () => {
  const dir = new URL("../public/app/", import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const raw = fs.readFileSync(new URL(f, dir), "utf8");
    const src = raw.replace(/^\s*\/\/.*$/gm, "");
    for (const sink of [".innerHTML", ".outerHTML", "insertAdjacentHTML", "document.write", "unsafeHTML", "new Function", "eval("]) {
      assert.ok(!src.includes(sink), `${f} uses ${sink}`);
    }
    assert.match(raw, /^\/\/ /, `${f} starts with a comment saying what it is`);
  }
});

test("hardening: vendored lit-html matches its recorded hashes, and the client imports only from it and itself", async () => {
  const { createHash } = await import("node:crypto");
  const base = new URL("../public/vendor/lit-html-3.2.1/", import.meta.url);
  for (const line of fs.readFileSync(new URL("SHA256SUMS", base), "utf8").trim().split("\n")) {
    const [hash, file] = line.split(/\s+/);
    assert.equal(createHash("sha256").update(fs.readFileSync(new URL(file, base))).digest("hex"), hash, file);
  }
  const dir = new URL("../public/app/", import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    for (const m of fs.readFileSync(new URL(f, dir), "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?\sfrom\s+'([^']+)'|\bimport\('([^']+)'\)/gm)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith("./") || spec.startsWith("/vendor/lit-html-3.2.1/"), `${f} imports ${spec}`);
      const target = spec.startsWith("./") ? new URL(spec, dir) : new URL("../public" + spec, import.meta.url);
      assert.ok(fs.existsSync(target), `${f}: ${spec} exists`);
    }
  }
});
