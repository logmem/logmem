#!/usr/bin/env node
// scripts/space-import.mjs — CLI for space import with a plan-first gate.
//
// Usage:
//   node scripts/space-import.mjs <bundle.json[.gz]>            # plan only (default)
//   node scripts/space-import.mjs <bundle.json> --confirm <checksum>   # apply
//   node scripts/space-import.mjs <bundle.json> --confirm <checksum> --overwrite
//   node scripts/space-import.mjs <bundle.json> --space other-space --confirm <checksum>
//
// The plan prints counts and conflict keys only, never bundle content.
// Apply happens only when --confirm equals the bundle checksum, so the file a
// person reviewed is the file that runs. Existing keys refuse the apply until
// --overwrite is passed with that same confirm.

import { readFileSync, writeFileSync } from "node:fs";
import { descriptorFromEnv, fromDescriptor } from "../src/lib/backend.mjs";
import { importSpace, parseBundle } from "../src/http/space-import.mjs";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: node scripts/space-import.mjs <bundle.json[.gz]> [--space <name>] [--confirm <checksum>] [--overwrite]");
    process.exit(1);
  }
  const spaceIdx = args.indexOf("--space");
  const confirmIdx = args.indexOf("--confirm");
  const overwrite = args.includes("--overwrite");
  const spaceOverride = spaceIdx !== -1 ? args[spaceIdx + 1] : null;
  const confirm = confirmIdx !== -1 ? args[confirmIdx + 1] : null;

  const input = readFileSync(file);
  const bundle = parseBundle(input); // verifies format and checksum before anything else
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

  console.log(`LogMem space import plan: -> ${space} (from ${bundle.space}, checksum ${bundle.checksum.slice(0, 16)}...)`);
  try {
    const plan = await importSpace(backend.redis, space, bundle, {
      dryRun: !approved,
      requireApproval: true,
      approved,
      overwrite: approved && overwrite,
    });
    if (plan.dryRun) {
      console.log(`[PLAN] would create ${plan.wouldCreate}, would overwrite ${plan.wouldOverwrite}, conflicts ${plan.conflicts.length}, skipped ${plan.skipped.length}`);
      if (plan.conflicts.length) console.log(`  first conflicts: ${plan.conflicts.slice(0, 5).join(", ")}`);
      if (plan.skipped.length) console.log(`  not restorable (export skipped these types): ${plan.skipped.slice(0, 5).map((s) => `${s.key}(${s.type})`).join(", ")}`);
      console.log("  Apply with --confirm <checksum> from this plan.");
      return;
    }
    console.log(`[SUCCESS] Imported into ${space}: created ${plan.written.created}, overwritten ${plan.written.overwritten}, skipped ${plan.skipped.length}`);
    if (overwrite && plan.wouldOverwrite) console.log(`  overwrote ${plan.written.overwritten} existing keys as requested`);
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("space-import.mjs")) {
  main();
}
