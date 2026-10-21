// The stdio server (what the npm package runs) must not import the hosted cloud/ code.
// PR #56 found the packed tarball could not start: src/server.mjs reached cloud/meter through limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/g;

function graph(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(IMPORT_RE)) {
      const next = resolve(dirname(file), m[1]);
      if (existsSync(next)) walk(next);
    }
  };
  walk(resolve(root, entry));
  return [...seen].map((f) => f.slice(root.length + 1));
}

test("stdio server: no import reaches cloud/ or api/", () => {
  const files = graph("src/server.mjs");
  assert.ok(files.includes("src/core/apply-limits.mjs"));
  assert.deepEqual(files.filter((f) => f.startsWith("cloud/") || f.startsWith("api/")), []);
});
