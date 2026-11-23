#!/usr/bin/env node
// decide-resign.mjs: re-sign pre-swap decisions under the new LOGMEM_DECIDE_SECRET.
// Job decide-resign-migration. See src/core/decide-resign.mjs for the rules.
//
// Usage (both keys come from the environment, never the command line):
//   infisical run --env=prod --path=/LogMem -- \
//     LOGMEM_DECIDE_SECRET_OLD=... node scripts/decide-resign.mjs --space madez --cutoff 2026-11-23T15:14:06Z
//   add --apply only after a person approves the dry-run counts.
//
// Prints counts only: never a key, a signature or decision content.

import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { validateKeySegments } from "../src/lib/helpers.mjs";
import { getSecret } from "../src/lib/secrets.mjs";
import { resignDecisions, summarizeResign, ResignError } from "../src/core/decide-resign.mjs";

function parseArgs(argv) {
  const f = { space: process.env.LOGMEM_SPACE || "", cutoff: null, apply: false, trails: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space" && argv[i + 1]) f.space = argv[++i];
    else if (a === "--cutoff" && argv[i + 1]) f.cutoff = argv[++i];
    else if (a === "--apply") f.apply = true;
    else if (a === "--list-trails") f.trails = true;
    else throw new ResignError(`unknown argument: ${a}`);
  }
  return f;
}

async function main() {
  const f = parseArgs(process.argv);
  if (!f.space) throw new ResignError("--space is required");
  validateKeySegments(f.space);
  const cutoff = /^\d+$/.test(String(f.cutoff)) ? Number(f.cutoff) : Date.parse(String(f.cutoff));
  if (!Number.isFinite(cutoff)) throw new ResignError("--cutoff is required: ms or an ISO time, the moment the new key went live");
  const backend = fromDescriptor(descriptorFromEnv());
  if (!backend?.redis) throw new ResignError("configure the durable Redis backend first");
  const store = createStore(backend.redis, { space: f.space });
  const report = await resignDecisions(store, {
    oldSecret: getSecret("LOGMEM_DECIDE_SECRET_OLD"),
    newSecret: getSecret("LOGMEM_DECIDE_SECRET"),
    cutoff,
    apply: f.apply,
  });
  const out = summarizeResign(report);
  // Trails are ask ids, not secrets; list them only on request, for the close-out step.
  if (f.trails) Object.assign(out, { trails: Object.fromEntries(["resigned", "altered", "after_cutoff", "unverifiable", "defer_only"].map((k) => [k, report[k]])), failed: report.failed });
  console.log(JSON.stringify(out, null, 2));
  if (report.failed.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof ResignError ? e.message : "decide-resign failed: " + (e?.message || e));
  process.exitCode = 1;
});
