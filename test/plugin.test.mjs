// LogMem agent plugin: both manifests are complete, the package carries no secrets
// or hooks, every file points at one MCP URL, and the skill copies match skills/.
// Spec: docs/superpowers/specs/2026-10-20-logmem-agent-plugin-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkills, SECRET_RES } from "../scripts/skills-lint.mjs";
import { diffSkills, syncSkills, SHIPPED_SKILLS, PLUGIN_ONLY_SKILLS } from "../scripts/plugin-sync.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN = join(ROOT, "plugins", "logmem");
const MCP_URL = "https://logmem.si/mcp";
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const json = (...p) => JSON.parse(readFileSync(join(...p), "utf8"));
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const portable = json(PLUGIN, "plugin.json");
const claude = json(PLUGIN, ".claude-plugin", "plugin.json");
const mcp = json(PLUGIN, "mcp.json");
const dotMcp = json(PLUGIN, ".mcp.json");

test("plugin: portable plugin.json has the Agent Plugins fields", () => {
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.match(portable.name, KEBAB);
  for (const k of ["version", "description", "homepage", "repository", "license"]) assert.ok(portable[k], k);
  assert.ok(portable.author?.name, "author.name");
  assert.ok(Array.isArray(portable.keywords) && portable.keywords.length, "keywords");
  assert.equal(portable.skills, undefined, "skills are discovered from skills/, no field");
});

test("plugin: OpenAI interface is complete and its paths stay in the package", () => {
  const oa = portable.extensions["com.openai"];
  const ui = oa.interface;
  for (const k of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "privacyPolicyURL", "termsOfServiceURL", "brandColor", "composerIcon", "logo"]) {
    assert.ok(ui[k], `interface.${k}`);
  }
  assert.deepEqual(ui.capabilities, ["Read", "Write"]);
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length >= 1);
  assert.match(ui.brandColor, /^#[0-9A-Fa-f]{6}$/);
  for (const u of [ui.websiteURL, ui.privacyPolicyURL, ui.termsOfServiceURL]) assert.match(u, /^https:\/\/logmem\.si(\/|$)/);
  for (const p of [ui.composerIcon, ui.logo, ...(ui.screenshots || []), oa.onboardingSkill]) {
    assert.match(p, /^\.\//, p);
    assert.ok(existsSync(join(PLUGIN, p)), `${p} exists`);
  }
  assert.equal(oa.onboardingSkill, "./skills/setup/SKILL.md");
});

test("plugin: Claude Code manifest matches the portable one", () => {
  assert.equal(claude.name, portable.name);
  assert.equal(claude.displayName, portable.extensions["com.openai"].interface.displayName);
  for (const k of ["version", "description", "homepage", "repository", "license"]) assert.equal(claude[k], portable[k], k);
  assert.deepEqual(claude.author, portable.author);
  assert.deepEqual(claude.keywords, portable.keywords);
  assert.ok(!/^(claude|anthropic|cc-plugin)-/.test(claude.name), "name must not pass as Anthropic's own");
  const ui = portable.extensions["com.openai"].interface;
  assert.equal(claude.privacyPolicyUrl, ui.privacyPolicyURL);
  assert.equal(claude.termsOfServiceUrl, ui.termsOfServiceURL);
  for (const u of [claude.documentationUrl, claude.supportUrl]) assert.match(u, /^https:\/\//);
  assert.ok(existsSync(join(PLUGIN, claude.icon)), "directory icon exists");
});

test("plugin: one MCP server, one URL, OAuth through DCR with no client secrets", () => {
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["logmem"]);
  assert.deepEqual(Object.keys(dotMcp.mcpServers), ["logmem"]);
  const s = mcp.mcpServers.logmem;
  assert.equal(s.type, "streamable-http");
  assert.equal(s.url, MCP_URL);
  assert.deepEqual(s.extensions["com.openai"].auth, { type: "oauth", client: { mode: "dcr" } });
  assert.deepEqual(dotMcp.mcpServers.logmem, { type: "http", url: MCP_URL });
  for (const f of ["README.md", "skills/setup/SKILL.md"]) {
    const text = readFileSync(join(PLUGIN, f), "utf8");
    assert.ok(text.includes(MCP_URL), `${f} names ${MCP_URL}`);
    const others = [...text.matchAll(/https:\/\/logmem\.si\/[\w/-]*mcp\b/g)].map((m) => m[0]).filter((u) => u !== MCP_URL);
    assert.deepEqual(others, [], `${f} names only one MCP URL`);
  }
});

test("plugin: no hooks, so it stays eligible for the public directory", () => {
  assert.ok(!existsSync(join(PLUGIN, "hooks")), "no hooks/ folder");
  assert.equal(claude.hooks, undefined);
  assert.equal(portable.hooks, undefined);
  assert.equal(portable.extensions["com.openai"].hooks, undefined);
  assert.ok(!existsSync(join(PLUGIN, "bin")), "no bin/: claude.ai will not install a plugin with one");
});

test("plugin: no secrets, credentials or headers anywhere in the package", () => {
  for (const f of files(PLUGIN)) {
    const text = readFileSync(join(PLUGIN, f), "utf8");
    for (const [re, what] of SECRET_RES) assert.ok(!re.test(text), `${f}: looks like a secret (${what})`);
    assert.ok(!/clientSecret|client_secret|"clientId"|"headers"\s*:/.test(text), `${f}: no client credentials or headers`);
    assert.ok(!/\b(rediss?:\/\/|UPSTASH_|lmk_)/.test(text), `${f}: no backend or key material`);
  }
});

test("plugin: skill copies match skills/ and the plugin skills pass the lint", () => {
  assert.deepEqual(diffSkills(), [], "run: node scripts/plugin-sync.mjs");
  const r = lintSkills(join(PLUGIN, "skills"));
  assert.deepEqual(r.skills, [...SHIPPED_SKILLS, ...PLUGIN_ONLY_SKILLS].sort());
  assert.deepEqual(r.errors, []);
});

test("plugin sync: --check catches a drifted, missing or unlisted skill, and sync repairs it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plugin-"));
  const source = join(tmp, "skills");
  const plugin = join(tmp, "plugin");
  cpSync(join(ROOT, "skills"), source, { recursive: true });
  cpSync(PLUGIN, plugin, { recursive: true });
  assert.deepEqual(diffSkills({ source, plugin }), []);
  writeFileSync(join(source, "logmem", "SKILL.md"), "changed\n");
  writeFileSync(join(source, "logmem-decisions", "extra.md"), "new\n");
  cpSync(join(source, "logmem-self-host"), join(plugin, "skills", "logmem-self-host"), { recursive: true });
  const p = diffSkills({ source, plugin });
  assert.ok(p.some((x) => x.startsWith("logmem/SKILL.md: differs")), p.join());
  assert.ok(p.some((x) => x.startsWith("logmem-decisions/extra.md: missing")), p.join());
  assert.ok(p.some((x) => x.startsWith("logmem-self-host: skill is not on the plugin list")), p.join());
  const after = syncSkills({ source, plugin });
  assert.deepEqual(after, ["logmem-self-host: skill is not on the plugin list"], "sync never deletes an unlisted skill for you");
  assert.ok(existsSync(join(plugin, "skills", "setup", "SKILL.md")), "sync leaves plugin-only skills alone");
});

test("plugin marketplaces: both repo catalogs list the plugin by its local path", () => {
  const oa = json(ROOT, ".agents", "plugins", "marketplace.json");
  assert.ok(oa.name && oa.interface?.displayName);
  assert.equal(oa.plugins.length, 1);
  const e = oa.plugins[0];
  assert.equal(e.name, portable.name);
  assert.deepEqual(e.source, { source: "local", path: "./plugins/logmem" });
  assert.ok(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(e.policy.installation));
  assert.ok(e.policy.authentication);
  assert.ok(e.category);

  const cc = json(ROOT, ".claude-plugin", "marketplace.json");
  assert.match(cc.name, KEBAB);
  assert.ok(cc.owner?.name && cc.description);
  assert.equal(cc.plugins.length, 1);
  assert.equal(cc.plugins[0].name, claude.name);
  assert.equal(cc.plugins[0].source, "./plugins/logmem");
  assert.equal(cc.plugins[0].version, undefined, "plugin.json owns the version");
  for (const p of [e.source.path, cc.plugins[0].source]) assert.ok(existsSync(join(ROOT, p, ".claude-plugin", "plugin.json")), p);
});

test("plugin: ships seven skills with self-host left out, and setup proves the first entry", () => {
  const dirs = readdirSync(join(PLUGIN, "skills")).sort();
  assert.deepEqual(dirs, ["logmem", "logmem-decisions", "logmem-onboard-agent", "logmem-read-path-recovery", "logmem-sdk-primitives", "logmem-track-outage", "setup"]);
  assert.ok(!dirs.includes("logmem-self-host"), "self-host shows a Redis URI, which the plugin bans");
  const setup = readFileSync(join(PLUGIN, "skills", "setup", "SKILL.md"), "utf8");
  assert.match(setup, /## 4\. Prove it worked/);
  for (const t of ["logmem_note", "logmem_view", "logmem_recall"]) assert.ok(setup.includes(t), t);
  assert.match(setup, /fixes the agent name/);
  assert.match(readFileSync(join(ROOT, "skills", "logmem-onboard-agent", "SKILL.md"), "utf8"), /connection fixes the agent name/);
});
