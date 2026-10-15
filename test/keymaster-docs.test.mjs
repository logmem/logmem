// test/keymaster-docs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkStyle } from "../src/core/style.mjs";

const agent = readFileSync(new URL("../cloud/keymaster/AGENT.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../cloud/keymaster/README.md", import.meta.url), "utf8");

test("keymaster docs: agent frontmatter limits tools", () => {
  assert.match(agent, /^---\nname: keymaster\n/);
  assert.match(agent, /\ntools: Bash, Read\n/);
  for (const must of ["never print", "logmem_ask", "agent-keymaster", "/fleet-shared/acmi"]) assert.ok(agent.toLowerCase().includes(must.toLowerCase()), must);
});

test("keymaster docs: README names the scripts and the canary", () => {
  for (const must of ["scripts/identity-canary.mjs", "scripts/keymaster-matrix.mjs", "/agents/<id>/canary", "Universal Auth"]) assert.ok(readme.includes(must), must);
});

test("keymaster docs: plain writing", () => {
  const body = agent.split("---").slice(2).join("---");
  assert.ok(checkStyle(body.replace(/```[\s\S]*?```/g, "")).filter((w) => w.rule !== "long_sentence").length === 0);
});
