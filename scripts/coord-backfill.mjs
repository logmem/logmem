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
  getCoordItem,
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
  const { space, dry = false } = flags;
  const backend = flags.store ? null : fromDescriptor(descriptorFromEnv());
  if (!flags.store && !backend?.redis) throw new Error("Configure a durable Redis backend before backfill");
  const store = flags.store || createStore(backend.redis, { space, compat: true });
  if (store.space !== space) throw new Error("Backfill space does not match the store");
  const limit = flags.limit;
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("limit must be a positive integer");
  const coverageKey = coordCoverageKey(space);
  const result = { ok: true, space, totalScanned: 0, itemsCreated: 0, itemsSettled: 0, status: "partial", warnings: [] };
  const warn = (message) => { if (!result.warnings.includes(message)) result.warnings.push(message); };
  const mark = async (status, extra = {}) => {
    if (dry) return;
    const fields = { status, space, ...extra };
    await store.redis("HSET", coverageKey, ...Object.entries(fields).flatMap(([k, v]) => [k, String(v)]));
  };
  try {
    const coverageType = await store.redis("TYPE", coverageKey);
    if (!dry && (flags.reset || coverageType === "string")) await store.redis("DEL", coverageKey);
    await mark("partial", { started_at: Date.now(), completed_at: "", error: "" });
    const revisionKey = `lm:${space}:rev`;
    const sourceRevision = await store.redis("GET", revisionKey);
    const records = [];
    // Read all registered source logs. A cap is explicit and never proves coverage.
    for (const ns of ["agent", "job", "channel"]) {
      for (const id of await store.list(ns)) {
        const log = await store.readLog(ns, id, limit == null ? {} : { limit: limit + 1 });
        if (log.warnings?.length) warn(`Unreadable source entries in ${ns}:${id}`);
        if (limit != null && log.length > limit) warn(`Read limit reached in ${ns}:${id}`);
        const entries = limit == null ? log : log.slice(0, limit);
        result.totalScanned += entries.length;
        for (const entry of entries) records.push({ entry, ns, id });
      }
    }
    const items = new Map();
    for (const { entry: e, ns, id } of records) {
      const type = e.kind === "handoff" ? "handoff" : e.kind === "huddle" ? "seat" : ["memo", "request"].includes(e.kind) ? "request" : null;
      if (!type) continue;
      const addressed = e.to ?? e.extra?.to;
      const recipients = addressed == null ? (type === "handoff" && ns === "agent" ? [id] : []) : Array.isArray(addressed) ? addressed : [addressed];
      if (!recipients.length) {
        if (type === "handoff") warn(`Handoff has no recipient in ${ns}:${id}`);
        continue;
      }
      if (!e.trail || !Number.isFinite(Number(e.ts)) || Number(e.ts) <= 0) {
        warn(`Request lacks identity or timestamp in ${ns}:${id}`);
        continue;
      }
      for (const rawTo of recipients) {
        if (typeof rawTo !== "string" || !rawTo || rawTo.startsWith("human:")) {
          if (typeof rawTo !== "string" || !rawTo) warn(`Invalid recipient in ${ns}:${id}`);
          continue;
        }
        const to = rawTo.replace(/^agent:/, "");
        const itemId = computeItemId(space, type, e.trail, to);
        const item = { space, type, requestTrail: e.trail, from: e.by || "unknown", to,
          where: e.job || e.extra?.job || (ns === "agent" ? "" : `${ns}:${id}`),
          summary: e.summary || e.kind, createdAt: Number(e.ts) };
        const previous = items.get(itemId);
        if (!previous || (!previous.where && item.where)) items.set(itemId, item);
      }
    }
    for (const [itemId, item] of items) {
      const existing = await getCoordItem(store, space, itemId);
      if (!existing) {
        if (!dry) {
          const created = await createCoordItem(store, item);
          if (!created.ok) throw new Error(`Cannot index ${itemId}: ${created.status}`);
          if (created.status === "ok") result.itemsCreated++;
        } else result.itemsCreated++;
      }
      if (existing && existing.response !== "open") continue;
      const matching = records.map(({ entry }) => entry).filter((e) => {
        if (!Number.isFinite(Number(e.ts)) || Number(e.ts) < item.createdAt) return false;
        if (String(e.by || "").replace(/^agent:/, "") !== item.to) return false;
        if (item.type === "handoff") return e.origin === item.requestTrail && (e.kind === "accepted" || (e.kind === "feedback" && isDeclined(e.payload)));
        // An origin alone is a reference, not evidence that a seat was answered.
        return (e.answers ?? e.extra?.answers) === itemId;
      }).sort((a, b) => Number(a.ts) - Number(b.ts));
      const settlement = matching[0];
      if (settlement) {
        if (!dry) {
          const settled = await settleCoordItem(store, { space, id: itemId, recipient: item.to,
            response: isDeclined(settlement.payload) || settlement.disposition === "declined" ? "declined" : "answered",
            settledBy: settlement.by, settledAt: Number(settlement.ts), settlementTrail: settlement.trail,
            disposition: settlement.payload?.reason || settlement.disposition || settlement.kind });
          if (!settled.ok && !settled.alreadySettled) throw new Error(`Cannot settle ${itemId}: ${settled.status}`);
          if (settled.ok) result.itemsSettled++;
        } else result.itemsSettled++;
      } else if (item.type !== "handoff" && records.some(({ entry }) => entry.origin === item.requestTrail && String(entry.by || "").replace(/^agent:/, "") === item.to)) {
        warn(`Response needs settlement verification for ${itemId}`);
      }
    }
    if ((await store.redis("GET", revisionKey)) !== sourceRevision) warn("Source logs changed during the scan. Run backfill again.");
    result.status = result.warnings.length ? "partial" : "complete";
    await mark(result.status, { completed_at: result.status === "complete" ? Date.now() : "",
      finished_at: Date.now(), total_scanned: result.totalScanned, items_created: result.itemsCreated,
      items_settled: result.itemsSettled, warnings: JSON.stringify(result.warnings) });
  } catch (error) {
    result.ok = false;
    result.status = "error";
    result.error = error.message;
    try { await mark("error", { error: error.message, completed_at: "", finished_at: Date.now() }); }
    catch { /* Keep the original failure when Redis is unavailable. */ }
  }
  if (!flags.quiet) {
    console.log(`[coord-backfill] ${space}${dry ? " (dry run)" : ""}: ${result.status}, ${result.totalScanned} entries, ${result.itemsCreated} created, ${result.itemsSettled} settled`);
    for (const warning of result.warnings) console.warn(`[coord-backfill] ${warning}`);
    if (result.error) console.error(`[coord-backfill] ${result.error}`);
  }
  return result;
}

if (process.argv[1] && process.argv[1].endsWith("coord-backfill.mjs")) {
  runCoordBackfill().then((result) => {
    if (!result.ok || result.status !== "complete") process.exitCode = 1;
  }).catch((err) => {
    console.error("[coord-backfill] Error:", err);
    process.exit(1);
  });
}
