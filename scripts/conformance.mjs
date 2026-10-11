#!/usr/bin/env node
// Run the ACMI conformance suite against LogMem compat mode.
//
//   npm run conformance                 # in-memory backend
//   LOGMEM_REDIS_URI=redis://... npm run conformance   # real Redis, throwaway space
//   ACMI_CONFORMANCE=/path/to/acmi/dist/testing/conformance.js npm run conformance
//
// The real-Redis run uses a fresh space per run (lm:conformance-<ts>:*) and
// never touches lm:madez:* or acmi:*.

import { pathToFileURL } from "node:url";
import { LogmemAcmiAdapter } from "../src/compat/acmi-adapter.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

const suitePath = process.env.ACMI_CONFORMANCE;
const { runConformanceTests } = suitePath
  ? await import(pathToFileURL(suitePath).href)
  : await import("@madezmedia/acmi/testing/conformance");

let factory;
let cleanup = async () => {};
if (process.env.LOGMEM_REDIS_URI) {
  const { nativeRedisCall } = await import("../src/lib/redis-native.mjs");
  const uri = process.env.LOGMEM_REDIS_URI;
  const space = `conformance-${Date.now()}`;
  // Each test gets a sub-space so tests stay independent, like fresh adapters.
  let n = 0;
  const redis = (...cmd) => nativeRedisCall(uri, ...cmd);
  factory = () => new LogmemAcmiAdapter(redis, { space: `${space}-${n++}`, name: "logmem-compat/redis" });
  cleanup = async () => {
    const keys = await redis("KEYS", `lm:${space}-*`);
    if (keys.length) await redis("DEL", ...keys);
    console.log(`cleaned ${keys.length} keys under lm:${space}-*`);
    process.exit(process.exitCode ?? 0);
  };
} else {
  factory = () => new LogmemAcmiAdapter(createMemoryRedis(), { name: "logmem-compat/memory" });
}

const result = await runConformanceTests(factory);
for (const r of result.results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `\n      ${r.error}`}`);
}
console.log(`\n${result.adapter}: ${result.passed}/${result.total} passed`);
if (result.failed) process.exitCode = 1;
await cleanup();
