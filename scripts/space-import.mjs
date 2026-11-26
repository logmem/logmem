#!/usr/bin/env node
// scripts/space-import.mjs — CLI for space import with a plan-first gate.
//
// Usage:
//   node scripts/space-import.mjs <bundle.json[.gz]>                                # plan only (default)
//   node scripts/space-import.mjs <bundle.json[.gz]> --confirm <checksum>           # apply
//   node scripts/space-import.mjs <bundle.json[.gz]> --confirm <checksum> --overwrite
//   node scripts/space-import.mjs <bundle.json[.gz]> --confirm <checksum> --skip-conflicts
//   node scripts/space-import.mjs <bundle.json[.gz]> --space other-space --confirm <checksum> [--receipt]

import { readFileSync } from "node:fs";
import { descriptorFromEnv, fromDescriptor } from "../src/lib/backend.mjs";
import { importSpace, parseBundle } from "../src/http/space-import.mjs";

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(["--space", "--confirm"]);
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) { i += 1; continue; }
    if (!args[i].startsWith("--")) { file = args[i]; break; }
  }
  if (!file) {
    console.error("Usage: node scripts/space-import.mjs <bundle.json[.gz]> [--space <name>] [--confirm <checksum>] [--overwrite] [--skip-conflicts] [--receipt]");
    process.exit(1);
  }
  const spaceIdx = args.indexOf("--space");
  const confirmIdx = args.indexOf("--confirm");
  const overwrite = args.includes("--overwrite");
  const skipConflicts = args.includes("--skip-conflicts");
  const recordReceipt = args.includes("--receipt");
  const spaceOverride = spaceIdx !== -1 ? args[spaceIdx + 1] : null;
  const confirm = confirmIdx !== -1 ? args[confirmIdx + 1] : null;

  const input = readFileSync(file);
  const bundle = parseBundle(input); // verifies format (v1 or v2) and checksum before anything else
  const space = spaceOverride || bundle.space;

  const approved = Boolean(confirm) && confirm === bundle.checksum;
  if (confirm && !approved) {
    console.error("Refused: --confirm does not match the bundle checksum. Re-read the plan and confirm the exact hash.");
    process.exit(1);
  }

  const desc = descriptorFromEnv();
  if (!desc) {
    console.error("Error: no Redis backend configured (check LOGMEM_DEPLOY_REDIS_URI or LOGMEM_REST_URL)");
    process.exit(1);
  }
  const backend = fromDescriptor(desc);

  console.log(`LogMem space import plan: -> ${space} (from ${bundle.space}, format ${bundle.format}, mode ${bundle.mode || "full"}, checksum ${bundle.checksum.slice(0, 16)}...)`);
  try {
    const plan = await importSpace(backend.redis, space, bundle, {
      dryRun: !approved,
      requireApproval: true,
      approved,
      overwrite: approved && overwrite,
      skipConflicts: approved && skipConflicts,
      recordReceipt: approved && recordReceipt,
      importedBy: "cli",
    });
    if (plan.dryRun) {
      console.log(`[PLAN] would create ${plan.wouldCreate}, would overwrite ${plan.wouldOverwrite}, conflicts ${plan.conflicts.length}, skipped ${plan.skipped.length}`);
      if (plan.manifest) {
        console.log(`  manifest: ${plan.manifest.agents} agents, ${plan.manifest.plans} plans, ${plan.manifest.milestones} milestones, ${plan.manifest.jobs} jobs, ${plan.manifest.decisions} decisions, ${plan.manifest.traces} traces`);
      }
      if (plan.conflicts.length) console.log(`  first conflicts: ${plan.conflicts.slice(0, 5).join(", ")}`);
      if (plan.skipped.length) console.log(`  not restorable (export skipped these types): ${plan.skipped.slice(0, 5).map((s) => `${s.key}(${s.type})`).join(", ")}`);
      console.log("  Apply with --confirm <checksum> from this plan.");
      return;
    }
    console.log(`[SUCCESS] Imported into ${space}: created ${plan.written.created}, overwritten ${plan.written.overwritten}, skippedConflicts ${plan.written.skippedConflicts}, skipped ${plan.skipped.length}`);
    if (overwrite && plan.wouldOverwrite) console.log(`  overwrote ${plan.written.overwritten} existing keys as requested`);
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("space-import.mjs")) {
  main();
}
