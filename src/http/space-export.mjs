// src/http/space-export.mjs — Space export and backup path with dry-run support.
//
// Spec: Layer 0 safety floor (Nov 6 2026).
// Exports all space entities (timelines, profiles, signals, decisions, coord)
// into a verifiable backup bundle with SHA-256 integrity checksum.
// Supports dry-run analysis and operator approval gating.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export class SpaceExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceExportError";
    this.code = code;
  }
}

export function validateSpaceName(space) {
  if (typeof space !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(space)) {
    throw new SpaceExportError("invalid_space", `Invalid space identifier: ${space}`);
  }
}

/**
 * Scan all Redis keys matching a pattern.
 */
export async function scanKeys(redis, pattern, batchSize = 100) {
  const matching = [];
  let cursor = "0";
  do {
    const res = await redis("SCAN", cursor, "MATCH", pattern, "COUNT", String(batchSize));
    if (!Array.isArray(res) || res.length < 2) break;
    cursor = String(res[0]);
    const keys = Array.isArray(res[1]) ? res[1] : [];
    for (const k of keys) matching.push(String(k));
  } while (cursor !== "0");
  return matching;
}

/**
 * Perform a space backup/export.
 * Options:
 *   - dryRun: boolean (if true, inspects entity counts and estimated size without exporting payloads)
 *   - gzip: boolean (if true, compresses output payload)
 *   - requireApproval: boolean (if true, checks for approved: true before exporting)
 *   - approved: boolean
 */
export async function exportSpace(redis, space, {
  dryRun = false,
  gzip = false,
  requireApproval = false,
  approved = false,
  now = Date.now(),
} = {}) {
  validateSpaceName(space);

  if (requireApproval && !dryRun && !approved) {
    throw new SpaceExportError("approval_required", "Space export requires explicit operator approval flag (approved: true)");
  }

  const prefix = `lm:${space}:`;
  const allKeys = await scanKeys(redis, `${prefix}*`);

  const categorized = {
    profiles: [],
    signals: [],
    timelines: [],
    decisions: [],
    other: [],
  };

  for (const k of allKeys) {
    const sub = k.slice(prefix.length);
    if (sub.startsWith("profile:")) categorized.profiles.push(k);
    else if (sub.startsWith("signals:")) categorized.signals.push(k);
    else if (sub.startsWith("timeline:") || sub.startsWith("t:")) categorized.timelines.push(k);
    else if (sub.startsWith("decision:") || sub.startsWith("ask:")) categorized.decisions.push(k);
    // Who/Now hashes and Log zsets (lm:{space}:{kind}:{id}:who|now|log) land in other.
    else categorized.other.push(k);
  }

  if (dryRun) {
    return {
      ok: true,
      space,
      dryRun: true,
      totalKeys: allKeys.length,
      counts: {
        profiles: categorized.profiles.length,
        signals: categorized.signals.length,
        timelines: categorized.timelines.length,
        decisions: categorized.decisions.length,
        other: categorized.other.length,
      },
      estimatedBytes: allKeys.length * 512,
      scanned_at: new Date(now).toISOString(),
    };
  }

  // Collect data
  const data = {
    profiles: {},
    signals: {},
    timelines: {},
    decisions: {},
    other: {},
  };

  for (const k of categorized.profiles) {
    const type = String(await redis("TYPE", k)).toLowerCase();
    if (type === "hash") {
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          try { parsed[entries[i]] = JSON.parse(entries[i + 1]); }
          catch { parsed[entries[i]] = entries[i + 1]; }
        }
      }
      data.profiles[k.slice(prefix.length)] = parsed;
    } else {
      const val = await redis("GET", k);
      try { data.profiles[k.slice(prefix.length)] = JSON.parse(val); }
      catch { data.profiles[k.slice(prefix.length)] = val; }
    }
  }

  for (const k of categorized.signals) {
    const type = String(await redis("TYPE", k)).toLowerCase();
    if (type === "hash") {
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          try { parsed[entries[i]] = JSON.parse(entries[i + 1]); }
          catch { parsed[entries[i]] = entries[i + 1]; }
        }
      }
      data.signals[k.slice(prefix.length)] = parsed;
    } else {
      const val = await redis("GET", k);
      try { data.signals[k.slice(prefix.length)] = JSON.parse(val); }
      catch { data.signals[k.slice(prefix.length)] = val; }
    }
  }

  for (const k of categorized.timelines) {
    const type = String(await redis("TYPE", k)).toLowerCase();
    if (type === "zset") {
      const entries = await redis("ZRANGE", k, "0", "-1", "WITHSCORES");
      const list = [];
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          list.push({ member: entries[i], score: Number(entries[i + 1]) });
        }
      }
      data.timelines[k.slice(prefix.length)] = list;
    } else if (type === "list") {
      data.timelines[k.slice(prefix.length)] = await redis("LRANGE", k, "0", "-1");
    } else {
      data.timelines[k.slice(prefix.length)] = await redis("GET", k);
    }
  }

  for (const k of categorized.decisions) {
    data.decisions[k.slice(prefix.length)] = await redis("GET", k);
  }

  for (const k of categorized.other) {
    const type = String(await redis("TYPE", k)).toLowerCase();
    const short = k.slice(prefix.length);
    if (type === "string") {
      data.other[short] = await redis("GET", k);
    } else if (type === "hash") {
      // Who and Now slots are hashes. Export field map so restore can HSET.
      const entries = await redis("HGETALL", k);
      const parsed = {};
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          try { parsed[entries[i]] = JSON.parse(entries[i + 1]); }
          catch { parsed[entries[i]] = entries[i + 1]; }
        }
      }
      data.other[short] = { __type: "hash", fields: parsed };
    } else if (type === "zset") {
      // Log slots are zsets. Export members with scores.
      const entries = await redis("ZRANGE", k, "0", "-1", "WITHSCORES");
      const list = [];
      if (Array.isArray(entries)) {
        for (let i = 0; i < entries.length; i += 2) {
          list.push({ member: entries[i], score: Number(entries[i + 1]) });
        }
      }
      data.other[short] = { __type: "zset", entries: list };
    } else if (type === "list") {
      data.other[short] = { __type: "list", entries: await redis("LRANGE", k, "0", "-1") };
    } else {
      data.other[short] = { __type: type || "unknown", skipped: true };
    }
  }

  const exportPayload = {
    format: "logmem-space-backup-v1",
    space,
    exported_at: new Date(now).toISOString(),
    counts: {
      keys: allKeys.length,
      profiles: categorized.profiles.length,
      signals: categorized.signals.length,
      timelines: categorized.timelines.length,
      decisions: categorized.decisions.length,
      other: categorized.other.length,
    },
    data,
  };

  const checksum = createHash("sha256").update(JSON.stringify(exportPayload), "utf8").digest("hex");
  exportPayload.checksum = checksum;
  const jsonString = JSON.stringify(exportPayload, null, 2);

  if (gzip) {
    const compressed = gzipSync(Buffer.from(jsonString, "utf8"));
    return {
      ok: true,
      space,
      dryRun: false,
      checksum,
      compressed: true,
      sizeBytes: compressed.length,
      buffer: compressed,
      counts: exportPayload.counts,
    };
  }

  return {
    ok: true,
    space,
    dryRun: false,
    checksum,
    compressed: false,
    sizeBytes: Buffer.byteLength(jsonString, "utf8"),
    json: jsonString,
    counts: exportPayload.counts,
  };
}
