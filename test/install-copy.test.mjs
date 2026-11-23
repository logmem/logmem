// Public setup copy must install the live npm package, not a GitHub checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(rootDir, "public");
const readPublic = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const TEXT_EXT = /\.(html|js|mjs|md|json|yml|yaml|txt|sh)$/;

function publicSources(dir = publicDir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) publicSources(path, out);
    else if (/\.(html|js|md)$/.test(name)) out.push(path);
  }
  return out;
}

test("public pages install LogMem from npm @logmem/mcp", () => {
  for (const path of publicSources()) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /not on npm/i, path);
    assert.doesNotMatch(text, /github:logmem\/logmem/, path);
  }

  const onboarding = readPublic("onboarding.html");
  assert.match(
    onboarding,
    /<div class="lm-alert lm-alert--info"><i class="lm-i" data-i="info" aria-hidden="true"><\/i><div>This command installs LogMem from npm \(<code class="mono">npx @logmem\/mcp<\/code>\)\. It needs Node\.js 22 or newer\. In the real flow your space token appears here in place of <code class="mono">&lt;space token&gt;<\/code>\.<\/div><\/div>/,
  );

  const snippets = readPublic("onboarding.js");
  const installs = snippets.match(/npx -y @logmem\/mcp/g) || [];
  const args = snippets.match(/"-y", "@logmem\/mcp"/g) || [];
  assert.ok(installs.length >= 2, "Claude Code and Aider run npx -y @logmem/mcp");
  assert.ok(args.length >= 4, "Codex, OpenCode, Goose, and mcpServers install @logmem/mcp");

  const docs = readPublic("docs.html");
  const docInstalls = docs.match(/npx -y @logmem\/mcp|@logmem\/mcp/g) || [];
  assert.ok(docInstalls.length >= 3, "docs install examples name @logmem/mcp");
});

function repoSources(dir = rootDir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) repoSources(path, out);
    else if (TEXT_EXT.test(name) && !path.endsWith(`${join("test", "install-copy.test.mjs")}`)) out.push(path);
  }
  return out;
}

test("the repo does not tell people LogMem is missing from npm or to install it from GitHub", () => {
  const hits = [];
  for (const path of repoSources()) {
    const text = readFileSync(path, "utf8");
    if (/not on npm/i.test(text) || /github:logmem\/logmem/.test(text)) hits.push(path.slice(rootDir.length));
  }
  assert.deepEqual(hits, []);
  const help = readFileSync(join(rootDir, "src/stdio/index.mjs"), "utf8");
  assert.match(help, /npx -y @logmem\/mcp/);
  const walk = readFileSync(join(rootDir, "docs/WALKTHROUGH.md"), "utf8");
  assert.match(walk, /npx -y @logmem\/mcp/);
  assert.match(walk, /args = \["-y", "@logmem\/mcp"\]/);
  const readme = readFileSync(join(rootDir, "README.md"), "utf8");
  assert.match(readme, /npx -y @logmem\/mcp/);
});
