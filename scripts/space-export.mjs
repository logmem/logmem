#!/usr/bin/env node
// scripts/space-export.mjs — CLI for space export and backup with dry-run support.
//
// Usage:
//   node scripts/space-export.mjs <space> [--v2] [--mode blueprint|full] [--no-redact] [--dry-run] [--gzip] [--out <file>] [--confirm]

import { writeFileSync } from "node:fs";
import { descriptorFromEnv, fromDescriptor } from "../src/lib/backend.mjs";
import { exportSpace } from "../src/http/space-export.mjs";

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(["--out", "--mode", "--name"]);
  let space = null;
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) { i += 1; continue; }
    if (!args[i].startsWith("-")) { space = args[i]; break; }
  }
  space = space || process.env.LOGMEM_SPACE || "madez";

  const dryRun = args.includes("--dry-run");
  const gzip = args.includes("--gzip");
  const v2 = args.includes("--v2");
  const redact = !args.includes("--no-redact");
  const confirm = args.includes("--confirm") || process.env.CONFIRM_EXPORT === "1";
  const outIdx = args.indexOf("--out");
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx !== -1 && args[modeIdx + 1] ? args[modeIdx + 1] : undefined;
  const nameIdx = args.indexOf("--name");
  const spaceName = nameIdx !== -1 && args[nameIdx + 1] ? args[nameIdx + 1] : null;

  const desc = descriptorFromEnv();
  if (!desc) {
    console.error("Error: no Redis backend configured (check LOGMEM_DEPLOY_REDIS_URI or LOGMEM_REST_URL)");
    process.exit(1);
  }
  const backend = fromDescriptor(desc);

  console.log(`LogMem space export: ${space} (dryRun: ${dryRun}, version: ${v2 || mode ? 2 : 1}, mode: ${mode || "full"})`);
  try {
    const res = await exportSpace(backend.redis, space, {
      dryRun,
      gzip,
      version: v2 || mode ? 2 : 1,
      mode,
      redact,
      spaceName,
      requireApproval: true,
      approved: confirm,
    });

    if (dryRun) {
      console.log(`[DRY RUN] Space ${space} summary:`);
      console.log(`  Total keys: ${res.totalKeys}${res.excludedKeys != null ? ` (excluded ${res.excludedKeys})` : ""}`);
      if (res.manifest) {
        console.log(`  Entities:   ${res.manifest.agents} agents, ${res.manifest.plans} plans, ${res.manifest.jobs} jobs, ${res.manifest.channels} channels, ${res.manifest.decisions} decisions`);
      } else {
        console.log(`  Profiles:   ${res.counts.profiles}`);
        console.log(`  Signals:    ${res.counts.signals}`);
        console.log(`  Timelines:  ${res.counts.timelines}`);
        console.log(`  Decisions:  ${res.counts.decisions}`);
      }
      console.log(`  Est. size:  ${Math.round(res.estimatedBytes / 1024)} KB`);
      return;
    }

    console.log(`[SUCCESS] Exported space ${space}:`);
    console.log(`  SHA-256: ${res.checksum}`);
    console.log(`  Size:    ${Math.round(res.sizeBytes / 1024)} KB (${res.compressed ? "gzip" : "json"})`);
    if (res.manifest) {
      console.log(`  Manifest: ${res.manifest.agents} agents, ${res.manifest.plans} plans, ${res.manifest.milestones} milestones, ${res.manifest.jobs} jobs, ${res.manifest.decisions} decisions, ${res.manifest.traces} traces`);
    }
    if (res.redaction) {
      console.log(`  Redaction: keysExcluded=${res.redaction.keysExcluded}, excludedKeyCount=${res.redaction.excludedKeyCount}, secretsRedacted=${res.redaction.secretsRedacted}`);
    }

    if (outFile) {
      writeFileSync(outFile, res.compressed ? res.buffer : res.json);
      console.log(`  Written to: ${outFile}`);
    }
  } catch (err) {
    console.error(`Export failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith("space-export.mjs")) {
  main();
}
