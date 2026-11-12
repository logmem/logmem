// src/http/space-import.mjs — Import a space backup bundle back into Redis.
//
// The mirror of space-export.mjs (Phase 6.3, spec: admin account screens).
// Safety model, same spirit as the export approval gate plus one more lock:
//   1. the bundle checksum must recompute (tamper and truncation refuse),
//   2. the plan is visible first: dry run lists creates, overwrites and conflicts,
//   3. apply needs approved: true, and the CLI only sets it when --confirm
//      carries the reviewed checksum,
//   4. existing keys are conflicts and are never touched unless overwrite: true,
//   5. key types that the export skipped (streams, sets) stay skipped and are
//      reported, never guessed.
//
// Restores every type the export writes: strings, hashes (Who and Now slots),
// zsets (Log and timelines), lists, and JSON values. A value the export parsed
// from JSON is written back with JSON.stringify, so round trips preserve shape.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { validateSpaceName } from "./space-export.mjs";

export const BUNDLE_FORMAT = "logmem-space-backup-v1";

export class SpaceImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpaceImportError";
    this.code = code;
  }
}

/** Parse a bundle from JSON text, a gzip buffer or an already parsed object,
 *  then recompute its checksum. Returns the bundle or throws SpaceImportError. */
export function parseBundle(input) {
  let bundle = input;
  if (Buffer.isBuffer(input)) bundle = input.toString("utf8");
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle);
    } catch (e) {
      let text;
      try { text = gunzipSync(input).toString("utf8"); } catch { throw new SpaceImportError("invalid_bundle", `Bundle is not valid JSON: ${e.message}`); }
      try { bundle = JSON.parse(text); } catch (e2) { throw new SpaceImportError("invalid_bundle", `Bundle is not valid JSON: ${e2.message}`); }
    }
  }
  if (!bundle || typeof bundle !== "object") throw new SpaceImportError("invalid_bundle", "Bundle must be an object");
  if (bundle.format !== BUNDLE_FORMAT) throw new SpaceImportError("invalid_bundle", `Unknown bundle format: ${String(bundle.format).slice(0, 40)}`);
  if (!bundle.data || typeof bundle.data !== "object") throw new SpaceImportError("invalid_bundle", "Bundle has no data block");
  if (typeof bundle.checksum !== "string") throw new SpaceImportError("invalid_bundle", "Bundle has no checksum");

  const { checksum, ...rest } = bundle;
  const recomputed = createHash("sha256").update(JSON.stringify(rest), "utf8").digest("hex");
  if (recomputed !== checksum) throw new SpaceImportError("checksum_mismatch", "Bundle checksum does not recompute; the file changed after export");
  return bundle;
}

/** One entry per restored key, mirroring the export's data shapes. */
function opsFor(fullKey, value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.__type === "hash") {
      return [{ kind: "hash", key: fullKey, fields: value.fields || {} }];
    }
    if (value.__type === "zset") return [{ kind: "zset", key: fullKey, entries: value.entries || [] }];
    if (value.__type === "list") return [{ kind: "list", key: fullKey, entries: value.entries || [] }];
    if (value.__type && value.skipped) return [{ kind: "skipped", key: fullKey, type: value.__type }];
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
      for (const op of opsFor(prefix + short, value)) ops.push({ category, short, ...op });
    }
  }
  return ops;
}

function fieldValue(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * Plan and optionally apply a bundle import.
 *   dryRun (default true) returns the plan with existing-key conflicts.
 *   Apply requires approved: true, and refuses conflicts unless overwrite.
 */
export async function importSpace(redis, space, input, {
  dryRun = true,
  requireApproval = true,
  approved = false,
  overwrite = false,
  now = Date.now(),
} = {}) {
  const bundle = parseBundle(input);
  const targetSpace = space || bundle.space;
  validateSpaceName(targetSpace);
  const ops = planBundle(bundle, targetSpace, { overwrite });

  // Existing-key conflicts: visible in the plan, refused on apply by default.
  const conflicts = [];
  const skipped = [];
  let wouldCreate = 0;
  let wouldOverwrite = 0;
  for (const op of ops) {
    if (op.kind === "skipped") { skipped.push({ key: op.key, type: op.type }); continue; }
    const exists = Number(await redis("EXISTS", op.key)) > 0;
    if (!exists) { wouldCreate += 1; continue; }
    if (overwrite) wouldOverwrite += 1;
    else conflicts.push(op.key);
  }

  const plan = {
    space: targetSpace,
    checksum: bundle.checksum,
    counts: bundle.counts,
    wouldCreate,
    wouldOverwrite,
    conflicts,
    skipped,
    imported_at: new Date(now).toISOString(),
  };

  if (dryRun) return { ok: true, dryRun: true, ...plan };
  if (requireApproval && !approved) throw new SpaceImportError("approval_required", "Import requires approved: true (the CLI sets this from --confirm with the reviewed checksum)");
  if (conflicts.length > 0) {
    throw new SpaceImportError("conflicts", `${conflicts.length} existing keys conflict; re-run with overwrite to replace them`);
  }

  const written = { created: 0, overwritten: 0 };
  for (const op of ops) {
    if (op.kind === "skipped") continue;
    const exists = Number(await redis("EXISTS", op.key)) > 0;
    if (exists) { await redis("DEL", op.key); written.overwritten += 1; } else written.created += 1;

    if (op.kind === "string") {
      await redis("SET", op.key, fieldValue(op.value));
    } else if (op.kind === "hash") {
      const args = [op.key];
      for (const [f, v] of Object.entries(op.fields)) args.push(f, fieldValue(v));
      if (args.length > 1) await redis("HSET", ...args);
    } else if (op.kind === "zset") {
      const args = [op.key];
      for (const e of op.entries) args.push(String(e.score), String(e.member));
      if (args.length > 1) await redis("ZADD", ...args);
    } else if (op.kind === "list") {
      if (op.entries.length > 0) await redis("RPUSH", op.key, ...op.entries.map(String));
    }
  }
  return { ok: true, dryRun: false, ...plan, written };
}
