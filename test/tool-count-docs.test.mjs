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
  const list = readme.slice(readme.indexOf("## Tools"), readme.indexOf("all as `logmem_<word>`"));
  const words = new Set([...list.matchAll(/[A-Z][a-z]+/g)].map((m) => m[0].toLowerCase()));
  assert.deepEqual(tools.filter((t) => !words.has(t)), []);
});
