#!/usr/bin/env node
// coord-backfill.mjs — Resumable backfill of historical coordination items.
//
// Part of the P0 Fleet Coordination Sync Contract (PR A).
// Scans logs in the given space, constructs item records for handoffs,
// populates coordination indexes, and reports coverage.
//
// Usage:
//   node scripts/coord-backfill.mjs [--space <space>] [--dry] [--reset]

import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import {
  computeItemId,
  createCoordItem,
  settleCoordItem,
  coordCoverageKey,
  COORD_DEADLINE_MS,
} from "../src/core/coord.mjs";
import { isDeclined } from "../src/core/tools.mjs";

function parseArgs(argv) {
  const flags = {
    space: process.env.LOGMEM_SPACE || "madez",
    dry: false,
    reset: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--space" && argv[i + 1]) {
      flags.space = argv[++i];
    } else if (a === "--dry") {
      flags.dry = true;
    } else if (a === "--reset") {
      flags.reset = true;
    }
  }
  return flags;
}

export async function runCoordBackfill(options = {}) {
  const flags = { ...parseArgs(process.argv), ...options };
  const space = flags.space;
  const dry = !!flags.dry;

  const desc = descriptorFromEnv();
  const backend = fromDescriptor(desc);
  const store = createStore({ space, backend });

  console.log(`[coord-backfill] Starting backfill for space '${space}' (dry: ${dry})...`);

  const coverageKey = coordCoverageKey(space);
  if (flags.reset && !dry) {
    await store.redis("DEL", coverageKey);
  }

  // Mark coverage as partial at start of scan
  if (!dry) {
    await store.redis(
      "HSET",
      coverageKey,
      "status", "partial",
      "started_at", String(Date.now()),
      "space", space
    );
  }

  const agents = await store.list("agent");
  const jobs = await store.list("job");
  const channels = await store.list("channel");

  let totalScanned = 0;
  let itemsCreated = 0;
  let itemsSettled = 0;

  // Scan agent logs
  for (const agent of agents) {
    const log = await store.readLog("agent", agent, { reverse: true, limit: 1000 });
    totalScanned += log.length;

    const settledTrails = new Map();
    for (const e of log) {
      if (e.origin && (e.kind === "accepted" || (e.kind === "feedback" && isDeclined(e.payload)))) {
        settledTrails.set(e.origin, {
          kind: e.kind,
          by: e.by || agent,
          ts: e.ts,
          trail: e.trail,
          reason: e.payload?.reason || "",
        });
      }
    }

    for (const e of log) {
      if (e.kind === "handoff" && e.trail) {
        const to = e.to || e.extra?.to || agent;
        const normTo = String(to).replace(/^agent:/, "");
        const itemId = computeItemId(space, "handoff", e.trail, normTo);
        const settlement = settledTrails.get(e.trail);

        if (!dry) {
          const res = await createCoordItem(store, {
            space,
            type: "handoff",
            requestTrail: e.trail,
            from: e.by || "unknown",
            to: normTo,
            where: e.job || e.extra?.job || "",
            summary: e.summary || "handoff",
            createdAt: e.ts || Date.now(),
          });
          if (res.ok) itemsCreated++;

          if (settlement) {
            await settleCoordItem(store, {
              space,
              id: itemId,
              recipient: normTo,
              response: settlement.kind === "accepted" ? "answered" : "declined",
              settledBy: settlement.by,
              settledAt: settlement.ts,
              settlementTrail: settlement.trail,
              disposition: settlement.reason || settlement.kind,
            });
            itemsSettled++;
          }
        } else {
          itemsCreated++;
          if (settlement) itemsSettled++;
        }
      }
    }
  }

  // Mark coverage complete
  const finishedAt = Date.now();
  if (!dry) {
    await store.redis(
      "HSET",
      coverageKey,
      "status", "complete",
      "completed_at", String(finishedAt),
      "total_scanned", String(totalScanned),
      "items_created", String(itemsCreated),
      "items_settled", String(itemsSettled)
    );
  }

  console.log(`[coord-backfill] Finished backfill for '${space}':`);
  console.log(`  - Logs scanned: ${totalScanned}`);
  console.log(`  - Items indexed: ${itemsCreated}`);
  console.log(`  - Items settled: ${itemsSettled}`);
  console.log(`  - Coverage status: complete`);

  return { ok: true, space, totalScanned, itemsCreated, itemsSettled, status: "complete" };
}

if (process.argv[1] && process.argv[1].endsWith("coord-backfill.mjs")) {
  runCoordBackfill().catch((err) => {
    console.error("[coord-backfill] Error:", err);
    process.exit(1);
  });
}
