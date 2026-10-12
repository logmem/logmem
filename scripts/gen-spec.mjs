#!/usr/bin/env node
// Regenerate docs/spec/tools.schema.json from the running tool definitions,
// so the spec's schemas can never drift from the code. CI-able:
//   node scripts/gen-spec.mjs --check   (exit 1 if the file is stale)
import { readFileSync, writeFileSync } from "node:fs";
import { createLogmem, SERVER_INFO } from "../src/server.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { KINDS, FIELDS, NAMESPACES, TOOLS } from "../src/core/vocab.mjs";
import { SLOTS } from "../src/core/keys.mjs";

const lm = createLogmem({ redis: createMemoryRedis(), space: "spec", compat: true, sessionId: "spec" });
const tools = lm.listTools();
const doc = {
  server: SERVER_INFO,
  status: "draft",
  logmem_tools: tools.filter((t) => t.name.startsWith("logmem_")).map((t) => ({ ...t, acmi_equivalent: TOOLS[t.name] })),
  acmi_compat_tools: tools.filter((t) => t.name.startsWith("acmi_")).map((t) => t.name),
  kinds: KINDS,
  fields: FIELDS,
  namespaces: NAMESPACES,
  slots: SLOTS,
};
const text = `${JSON.stringify(doc, null, 2)}\n`;
const path = new URL("../docs/spec/tools.schema.json", import.meta.url);
if (process.argv.includes("--check")) {
  const cur = readFileSync(path, "utf8");
  if (cur !== text) {
    console.error("docs/spec/tools.schema.json is stale: run node scripts/gen-spec.mjs");
    process.exit(1);
  }
  console.log("spec schema up to date");
} else {
  writeFileSync(path, text);
  console.log(`wrote ${tools.length} tool definitions`);
}
