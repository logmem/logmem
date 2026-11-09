// Public setup copy must install the live npm package, not a GitHub checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const readPublic = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");

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
