// The README and the tools.mjs header name every logmem_* tool and the right count (launch copy says 23).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const tools = [...new Set([...read("src/core/tools.mjs").matchAll(/name: "logmem_([a-z_]+)"/g)].map((m) => m[1]))];

test("docs: README and tools.mjs state the real logmem tool count", () => {
  const n = tools.length;
  assert.match(read("src/core/tools.mjs").split("\n")[0], new RegExp(`the ${n} logmem_\\* tools`));
  assert.match(read("README.md"), new RegExp(`The ${n} \`logmem_\\*\` tools`));
});

test("docs: the README tool list names every logmem tool", () => {
  const readme = read("README.md");
  const start = readme.indexOf("## The MCP surface");
  assert.notEqual(start, -1, "README must include the MCP surface section");
  const end = readme.indexOf("\n## ", start + 1);
  const list = readme.slice(start, end === -1 ? undefined : end);
  const words = new Set([...list.matchAll(/`logmem_([a-z_]+)`/g)].map((m) => m[1]));
  assert.deepEqual([...words].sort(), [...tools].sort());
});
