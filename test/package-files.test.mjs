import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "server.json"), "utf8"));
const cache = mkdtempSync(join(tmpdir(), "logmem-package-test-"));
let archive;
try {
  [archive] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
} finally {
  rmSync(cache, { recursive: true, force: true });
}
const packed = new Set(archive.files.map((file) => file.path));

test("package: npm ownership metadata matches its registry server identity", () => {
  assert.equal(pkg.mcpName, manifest.name);
  assert.equal(manifest.packages[0].identifier, pkg.name);
  assert.equal(manifest.packages[0].version, pkg.version);
  assert.equal(manifest.version, pkg.version);
});

test("package: archive includes its registry manifest and license without hosted files", () => {
  assert.ok(packed.has("server.json"), "the published package carries its registry manifest");
  assert.ok(packed.has("LICENSE"));
  for (const path of packed) {
    assert.ok(!/^(api|cloud|public|test|reference)\//.test(path), `hosted or test file leaked: ${path}`);
    assert.ok(!/(^|\/)\.env(?:\.|$)/.test(path), `environment file leaked: ${path}`);
  }
});

test("package: all stdio imports ship with their required production dependencies", () => {
  const seen = new Set();
  function visit(path) {
    const name = relative(root, path);
    if (seen.has(name)) return;
    seen.add(name);
    assert.ok(packed.has(name), `stdio dependency missing from archive: ${name}`);
    const source = readFileSync(path, "utf8");
    const patterns = [/^\s*(?:import|export)\s+[^;\n]*?\s+from\s*["']([^"'\r\n]+)["']/gm, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /^\s*import\s*["']([^"'\r\n]+)["']/gm];
    for (const pattern of patterns) for (const [, specifier] of source.matchAll(pattern)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) visit(resolve(dirname(path), specifier));
      else {
        const parts = specifier.split("/");
        const dependency = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        assert.ok(Object.hasOwn(pkg.dependencies, dependency), `runtime import needs a production dependency: ${dependency}`);
      }
    }
  }
  visit(resolve(root, pkg.bin["logmem-mcp"]));
});
