import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

test("DESIGN.md frontmatter stays aligned with public/ds/tokens/logmem.css", () => {
  const designMd = readFileSync(join(ROOT, "DESIGN.md"), "utf8");
  const tokensCss = readFileSync(join(ROOT, "public/ds/tokens/logmem.css"), "utf8");

  assert.match(designMd, /^---\n[\s\S]+?\n---/, "DESIGN.md must start with YAML frontmatter");
  assert.match(designMd, /^name:\s*LogMem$/m);
  assert.match(designMd, /^## Overview$/m);
  assert.match(designMd, /^## Themes$/m);
  assert.match(designMd, /^## Do's and Don'ts$/m);

  const fm = designMd.match(/^---\n([\s\S]+?)\n---/)[1];
  const colorSection = fm.match(/^colors:\n((?:  .+\n)+)/m);
  assert.ok(colorSection, "DESIGN.md frontmatter must define colors");

  const colorKeys = [...colorSection[1].matchAll(/^  ([a-z0-9-]+):/gm)].map((m) => m[1]);
  assert.ok(colorKeys.length >= 25, "expected full semantic color token set");
  for (const key of colorKeys) {
    assert.ok(
      tokensCss.includes(`--${key}:`),
      `DESIGN.md color token '${key}' missing from public/ds/tokens/logmem.css`,
    );
  }
});

test("public/ds/components/bundle.css ships all v0.2 primitives with zero raw hex", () => {
  const bundle = readFileSync(join(ROOT, "public/ds/components/bundle.css"), "utf8");
  const marker = "LogMem Design System v0.2";
  const idx = bundle.indexOf(marker);
  assert.ok(idx !== -1, "v0.2 section header must exist in bundle.css");

  const v02 = bundle.slice(idx);
  const required = [
    ".lm-page-header",
    ".lm-status-strip",
    ".lm-stat-tile",
    ".lm-copy-id",
    ".lm-age-chip",
    ".lm-kind-chip",
    ".lm-entry-row",
    ".lm-readonly-flag",
    ".lm-orb",
    ".lm-cite-chip",
    ".lm-skeleton",
    "prefers-reduced-motion: reduce",
  ];
  for (const sel of required) {
    assert.ok(v02.includes(sel), `missing v0.2 selector or rule: ${sel}`);
  }

  const rawHex = v02.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(rawHex, null, `v0.2 section in bundle.css must not contain raw hex: ${rawHex}`);
});

test("apps/dashboard/app/globals.css imports tokens + bundle and maps @theme with zero raw hex", () => {
  const globals = readFileSync(join(ROOT, "apps/dashboard/app/globals.css"), "utf8");
  assert.match(globals, /public\/ds\/tokens\/logmem\.css/);
  assert.match(globals, /public\/ds\/components\/bundle\.css/);
  assert.match(globals, /@theme inline/);
  assert.match(globals, /--color-brand:\s*var\(--brand\)/);
  assert.match(globals, /--color-decision:\s*var\(--decision\)/);

  const rawHex = globals.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(rawHex, null, `globals.css must not contain raw hex: ${rawHex}`);
});
