// src/http/space-import.mjs — Import a space backup bundle (v1 or v2) back into Redis.
//
// Safety model:
//   1. the bundle checksum must recompute (tamper and truncation refuse),
//   2. the plan is visible first: dry run lists semantic manifest, creates, overwrites and conflicts,
//   3. apply needs approved: true (CLI/UI confirm with the reviewed checksum),
//   4. existing keys are conflicts and are never touched unless overwrite: true or skipConflicts: true,
//   5. key types that the export skipped (streams, unknown) stay skipped and are reported,
//   6. restores strings, hashes, zsets, lists, and v2 sets (agent:list, job:list, channel:list, plan:list, blocker:open).

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  BUNDLE_FORMAT_V1,
  BUNDLE_FORMAT_V2,
  buildManifestFromData,
  validateSpaceName,
} from "./space-export.mjs";

export const BUNDLE_FORMAT = BUNDLE_FORMAT_V1;
export const SUPPORTED_BUNDLE_FORMATS = new Set([BUNDLE_FORMAT_V1, BUNDLE_FORMAT_V2]);
export const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB safety cap

export class SpaceImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceImportError";
    this.code = code;
  }
}

/** Reject malformed or escaping relative keys from untrusted bundles. */
function validateShortKey(short) {
  if (typeof short !== "string" || !short || short.length > 256 || /[\x00-\x1f\x7f\s]/.test(short)) {
    throw new SpaceImportError("invalid_key", `Bundle contains an invalid key segment`);
  }
}

/** Parse a bundle from JSON text, a gzip buffer or an already parsed object,
 *  then recompute its checksum. Accepts v1 and v2 bundles. */
export function parseBundle(input, { maxBytes = MAX_DECOMPRESSED_BYTES } = {}) {
  let bundle = input;
  if (Buffer.isBuffer(input)) {
    // Check gzip magic header 0x1f 0x8b first to avoid UTF-8 decoding binary gzip unnecessarily
    if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
      let inflated;
      try {
        inflated = gunzipSync(input, { maxOutputLength: maxBytes });
      } catch (e) {
        if (e && e.code === "ERR_BUFFER_TOO_LARGE") {
          throw new SpaceImportError("bundle_too_large", "Decompressed bundle exceeds maximum allowed size");
        }
        throw new SpaceImportError("invalid_bundle", `Bundle is not valid gzip JSON: ${e.message}`);
      }
      bundle = inflated.toString("utf8");
    } else {
      if (input.length > maxBytes) {
        throw new SpaceImportError("bundle_too_large", "Bundle exceeds maximum allowed size");
      }
      bundle = input.toString("utf8");
    }
  }
  if (typeof bundle === "string") {
    if (Buffer.byteLength(bundle, "utf8") > maxBytes) {
      throw new SpaceImportError("bundle_too_large", "Bundle exceeds maximum allowed size");
    }
    try {
      bundle = JSON.parse(bundle);
    } catch (e) {
      let text;
      try { text = gunzipSync(input, { maxOutputLength: maxBytes }).toString("utf8"); }
      catch { throw new SpaceImportError("invalid_bundle", `Bundle is not valid JSON: ${e.message}`); }
      try { bundle = JSON.parse(text); }
      catch (e2) { throw new SpaceImportError("invalid_bundle", `Bundle is not valid JSON: ${e2.message}`); }
    }
  }
  if (!bundle || typeof bundle !== "object") throw new SpaceImportError("invalid_bundle", "Bundle must be an object");
  if (!SUPPORTED_BUNDLE_FORMATS.has(bundle.format)) {
    throw new SpaceImportError("invalid_bundle", `Unknown bundle format: ${String(bundle.format).slice(0, 40)}`);
  }
  if (!bundle.data || typeof bundle.data !== "object") throw new SpaceImportError("invalid_bundle", "Bundle has no data block");
  if (typeof bundle.checksum !== "string") throw new SpaceImportError("invalid_bundle", "Bundle has no checksum");

  const { checksum, ...rest } = bundle;
  const recomputed = createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex");
  if (recomputed !== checksum) {
    throw new SpaceImportError("checksum_mismatch", "Bundle checksum does not recompute; the file changed after export");
  }
  return bundle;
}

/** One entry per restored key, mirroring the export's data shapes. */
function opsFor(fullKey, value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.__type && value.skipped) return [{ kind: "skipped", key: fullKey, type: value.__type }];
    if (value.__type === "hash") {
      return [{ kind: "hash", key: fullKey, fields: value.fields || {} }];
    }
    if (value.__type === "zset") return [{ kind: "zset", key: fullKey, entries: value.entries || [] }];
    if (value.__type === "list") return [{ kind: "list", key: fullKey, entries: value.entries || [] }];
    if (value.__type === "set") return [{ kind: "set", key: fullKey, members: Array.isArray(value.members) ? value.members : [] }];
    // profiles and signals: hash fields stored as a plain object
    return [{ kind: "hash", key: fullKey, fields: value }];
  }
  if (Array.isArray(value)) {
    const zset = value.length > 0 && typeof value[0] === "object" && value[0] !== null && "member" in value[0];
    return zset
      ? [{ kind: "zset", key: fullKey, entries: value }]
      : [{ kind: "list", key: fullKey, entries: value }];
  }
  return [{ kind: "string", key: fullKey, value }];
}

/** All planned ops for a bundle into a space. Read only. */
export function planBundle(bundle, space, { overwrite = false } = {}) {
  validateSpaceName(space);
  const prefix = `lm:${space}:`;
  const ops = [];
  for (const [category, entries] of Object.entries(bundle.data)) {
    if (!entries || typeof entries !== "object") continue;
    for (const [short, value] of Object.entries(entries)) {
      validateShortKey(short);
      for (const op of opsFor(prefix + short, value)) ops.push({ category, short, ...op });
    }
  }
  return ops;
}

function fieldValue(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

async function mapConcurrent(items, limit, fn) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Plan and optionally apply a bundle import.
 * @param {any} redis
 * @param {string} space
 * @param {any} input
 * @param {{ dryRun?: boolean, requireApproval?: boolean, approved?: boolean, overwrite?: boolean, skipConflicts?: boolean, recordReceipt?: boolean, importedBy?: string | null, now?: number }} [opts]
 */
export async function importSpace(redis, space, input, {
  dryRun = true,
  requireApproval = true,
  approved = false,
  overwrite = false,
  skipConflicts = false,
  recordReceipt = false,
  importedBy = null,
  now = Date.now(),
} = {}) {
  const bundle = parseBundle(input);
  const targetSpace = space || bundle.space;
  validateSpaceName(targetSpace);
  const ops = planBundle(bundle, targetSpace, { overwrite });
  const manifest = bundle.manifest || buildManifestFromData(bundle.data);

  // Existing-key conflicts: visible in the plan, refused on apply unless overwrite or skipConflicts.
  const CONCURRENCY = 24;
  const conflicts = [];
  const skipped = [];
  let wouldCreate = 0;
  let wouldOverwrite = 0;
  let wouldSkipConflicts = 0;

  const existFlags = await mapConcurrent(ops, CONCURRENCY, async (op) => {
    if (op.kind === "skipped") return null;
    return Number(await redis("EXISTS", op.key)) > 0;
  });

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "skipped") { skipped.push({ key: op.key, type: op.type }); continue; }
    const exists = existFlags[i];
    if (!exists) { wouldCreate += 1; continue; }
    if (overwrite) wouldOverwrite += 1;
    else if (skipConflicts) { wouldSkipConflicts += 1; conflicts.push(op.key); }
    else conflicts.push(op.key);
  }

  const plan = {
    format: bundle.format,
    sourceSpace: bundle.space,
    sourceSpaceName: bundle.spaceName || bundle.space,
    mode: bundle.mode || "full",
    redaction: bundle.redaction || { keysExcluded: true, excludedKeyCount: 0, secretsRedacted: 0 },
    manifest,
    space: targetSpace,
    checksum: bundle.checksum,
    counts: bundle.counts,
    wouldCreate,
    wouldOverwrite,
    wouldSkipConflicts,
    conflicts,
    skipped,
    imported_at: new Date(now).toISOString(),
  };

  if (dryRun) return { ok: true, dryRun: true, ...plan };
  if (requireApproval && !approved) {
    throw new SpaceImportError("approval_required", "Import requires approved: true (the CLI/UI sets this from the reviewed checksum)");
  }
  if (conflicts.length > 0 && !overwrite && !skipConflicts) {
    throw new SpaceImportError("conflicts", `${conflicts.length} existing keys conflict; re-run with overwrite or skipConflicts`);
  }

  const written = { created: 0, overwritten: 0, skippedConflicts: 0 };
  const writeOps = ops.filter((op) => op.kind !== "skipped");
  await mapConcurrent(writeOps, CONCURRENCY, async (op) => {
    const exists = Number(await redis("EXISTS", op.key)) > 0;
    if (exists) {
      if (skipConflicts && !overwrite) {
        written.skippedConflicts += 1;
        return;
      }
      await redis("DEL", op.key);
      written.overwritten += 1;
    } else {
      written.created += 1;
    }

    if (op.kind === "string") {
      await redis("SET", op.key, fieldValue(op.value));
    } else if (op.kind === "hash") {
      const args = [op.key];
      for (const [f, v] of Object.entries(op.fields)) args.push(f, fieldValue(v));
      if (args.length > 1) await redis("HSET", ...args);
    } else if (op.kind === "zset") {
      // Chunk large ZADDs so huge timelines never trip Redis command byte limits
      const CHUNK = 200;
      for (let i = 0; i < op.entries.length; i += CHUNK) {
        const args = [op.key];
        for (const e of op.entries.slice(i, i + CHUNK)) args.push(String(e.score), String(e.member));
        if (args.length > 1) await redis("ZADD", ...args);
      }
    } else if (op.kind === "list") {
      const CHUNK = 200;
      for (let i = 0; i < op.entries.length; i += CHUNK) {
        const slice = op.entries.slice(i, i + CHUNK).map(String);
        if (slice.length > 0) await redis("RPUSH", op.key, ...slice);
      }
    } else if (op.kind === "set") {
      const CHUNK = 200;
      for (let i = 0; i < op.members.length; i += CHUNK) {
        const slice = op.members.slice(i, i + CHUNK).map(String);
        if (slice.length > 0) await redis("SADD", op.key, ...slice);
      }
    }
  });

  if (recordReceipt) {
    const receipt = {
      sourceSpace: bundle.space,
      sourceSpaceName: bundle.spaceName || bundle.space,
      mode: bundle.mode || "full",
      checksum: bundle.checksum,
      importedAt: now,
      importedBy: importedBy || "unknown",
      agentCount: manifest.agents,
      planCount: manifest.plans,
      jobCount: manifest.jobs,
      traceCount: manifest.traces,
    };
    await redis("SET", `lm:${targetSpace}:meta:import`, JSON.stringify(receipt));
    try { await redis("INCR", `lm:${targetSpace}:rev`); } catch { /* best-effort rev bump */ }
  }

  return { ok: true, dryRun: false, ...plan, written };
}
