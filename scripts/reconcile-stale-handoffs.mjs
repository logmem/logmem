#!/usr/bin/env node
// reconcile-stale-handoffs.mjs — sweep and archive stale orphan handoffs older than 48h.
//
// Usage:
//   node scripts/reconcile-stale-handoffs.mjs [--space madez] [--max-age-hours 48] [--apply]
//
// By default, runs in dry-run mode without modifying data. Pass --apply to write permanent decline records.

import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { reconcileStaleHandoffs } from "../src/core/reconcile.mjs";

process.env.LOGMEM_REDIS_URI = process.env.LOGMEM_CUSTOMER_REDIS_URI || process.env.LOGMEM_REDIS_URI;

const argv = process.argv.slice(2);
const arg = (name, def) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const space = arg("space", "madez");
const maxAgeHours = Number(arg("max-age-hours", "48")) || 48;
const apply = argv.includes("--apply");
const dryRun = !apply;

const d = descriptorFromEnv();
if (!d) {
  console.error("No Redis backend configured (set LOGMEM_REDIS_URI or LOGMEM_CUSTOMER_REDIS_URI)");
  process.exit(1);
}

const { redis } = fromDescriptor(d);
const store = createStore(redis, { space, compat: false });

console.log(`Scanning space '${space}' for orphan handoffs older than ${maxAgeHours} hours...`);

if (dryRun) {
  console.log("[DRY RUN] No writes will be performed. Pass --apply to execute permanent settlement.");
  // Dry run scan using the same logic without appending
  const agents = await store.list("agent");
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const stale = [];

  for (const agent of agents) {
    const log = await store.readLog("agent", agent, { reverse: true }).catch(() => []);
    const { isHandoffKind, handoffSettlement } = await import("../src/core/tools.mjs");
    const { computeItemId, getCoordItem } = await import("../src/core/coord.mjs");
    const settled = new Set(log.filter(e => e.by === `agent:${agent}` && e.origin && handoffSettlement(e.kind, e.payload)).map(e => e.origin));
    const seen = new Set();
    for (const e of log) {
      if (!isHandoffKind(e.kind) || e.to !== `agent:${agent}` || !e.trail || settled.has(e.trail) || seen.has(e.trail)) continue;
      seen.add(e.trail);
      const created = Number(e.ts);
      if (!Number.isFinite(created) || created <= 0 || (now - created) < maxAgeMs) continue;
      const id = computeItemId(store.space, "handoff", e.trail, agent);
      const existing = await getCoordItem(store, store.space, id);
      if (existing && ["answered", "declined"].includes(existing.response)) continue;
      stale.push({ trail: e.trail, to: e.to, from: e.by, hours_old: ((now - created) / (3600 * 1000)).toFixed(1), summary: e.summary });
    }
  }
  console.log(`Found ${stale.length} stale handoffs eligible for reconciliation:`);
  for (const s of stale) {
    console.log(`- [${s.hours_old}h] ${s.from} -> ${s.to}: ${s.summary || "(no summary)"} (${s.trail})`);
  }
  process.exit(0);
}

const res = await reconcileStaleHandoffs(store, {
  maxAgeMs: maxAgeHours * 3600 * 1000,
  now: Date.now(),
  reason: `Auto-reconciled stale orphan handoff (older than ${maxAgeHours}h)`,
});

console.log(`\nReconciliation complete in space '${res.space}'. Total reconciled: ${res.count}`);
for (const item of res.reconciled) {
  console.log(`✔ Reconciled [${item.age_hours}h old]: ${item.from} -> ${item.to} (${item.trail})`);
}
if (res.failures && res.failures.length > 0) {
  console.warn(`\n⚠ Failures encountered (${res.failures.length}):`);
  for (const f of res.failures) {
    console.warn(`- Failed ${f.to} (${f.trail}): ${f.error}`);
  }
}

process.exit(0);
