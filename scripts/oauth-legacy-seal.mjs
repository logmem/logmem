#!/usr/bin/env node
// One-off migration for pre-hash OAuth records on the deploy Redis.
//
// Before T0-a, tokens were stored plaintext under their raw value:
//   lm:oauth:token:<raw access>   lm:oauth:refresh:<raw refresh>   lm:oauth:code:<raw code>
// This script finds those records (raw 64-hex suffix AND no `creds` envelope)
// and either seals them into the hashed layout (default) or deletes them:
//   seal:   access  -> lm:oauth:at:<sha256>  (sealed creds, remaining TTL), old key deleted
//           refresh -> lm:oauth:rt:<sha256>  (sealed creds, remaining TTL), old key deleted
//           code    -> deleted (10 min lifetime; not worth migrating)
//   --delete: every legacy record is deleted (users re-authorize).
//
// Records already in the hashed layout but on the v1 envelope (constant AAD,
// sealed before record binding) are NOT re-sealed: re-sealing would launder
// a v1 blob an attacker spliced under their own key into a valid v2 record.
// Seal mode leaves them alone; they keep working until LEGACY_CUTOFF_MS
// (2026-10-26) and then stop opening, and those users simply re-authorize.
// --delete removes them now instead.
//
// Wrong-KEK guard (seal mode): before writing anything, every sealed
// lm:oauth:at:* / lm:oauth:rt:* record is test-opened with the configured
// KEK. A record that does not open is never deleted: it is skipped and
// counted, NOTHING is written in that run (the KEK is probably wrong, and
// sealing legacy records under it would lock those users out too), and the
// CLI exits non-zero. Deleting only ever happens with an explicit --delete.
//
// A raw access token and raw refresh token minted together share client_id,
// space, sub, scope, and issued_at. Seal mode joins that 1:1 pair into one
// grant family (fid on both, sibling_at on the refresh, fam:<fid> set) so a
// later reuse inside the grace window revokes the pre-migration access token
// along with the rotated pair. Ambiguous groups (not exactly one of each)
// are sealed without a family rather than cross-linked.
//
// Legacy records are sealed with a TTL clamped to min(remaining TTL, the
// kind's TTL, expires_at - now); expires_at itself is never changed.
//
// DRY RUN by default: prints what it would do. Pass --apply to write.
// Seal mode requires LOGMEM_OAUTH_KEK. Uses LOGMEM_DEPLOY_REST_URL/_TOKEN
// (same resolution as api/oauth/_lib/storage.mjs). Never prints token values
// or credentials: keys are shown as sha256 prefixes only.
//
//   node scripts/oauth-legacy-seal.mjs              # dry run, seal plan
//   node scripts/oauth-legacy-seal.mjs --delete     # dry run, delete plan
//   node scripts/oauth-legacy-seal.mjs --apply      # do it

import { pathToFileURL } from "node:url";
import { KEY, TTL, LEGACY_CUTOFF_MS, deployRedis, loadKek, parse, sealRecord, sha256hex, randomToken, isV1Sealed, canOpenRecord, storageNow } from "../api/oauth/_lib/storage.mjs";

const KINDS = [
  { kind: "access", prefix: "lm:oauth:token:", dest: KEY.access, ttl: TTL.access },
  { kind: "refresh", prefix: "lm:oauth:refresh:", dest: KEY.refresh, ttl: TTL.refresh },
  { kind: "code", prefix: "lm:oauth:code:", dest: null, ttl: TTL.code },
];
// Hashed-layout prefixes: preflight-checked in seal mode, v1 deleted only with --delete.
const HASHED_KINDS = [
  { kind: "access", prefix: "lm:oauth:at:", ttl: TTL.access },
  { kind: "refresh", prefix: "lm:oauth:rt:", ttl: TTL.refresh },
];

/** Identity of one grant at mint time. null when the record cannot be paired safely. */
function pairKey(rec) {
  if (!rec || typeof rec.client_id !== "string" || rec.client_id.length === 0) return null;
  if (typeof rec.issued_at !== "number" || !Number.isFinite(rec.issued_at)) return null;
  return [rec.client_id, rec.space ?? "", rec.sub ?? "", rec.scope ?? "", String(rec.issued_at)].join("\0");
}

/**
 * Give each unambiguous raw access/refresh pair one family id. The refresh
 * record's sibling_at is the hash the sealed access token will be stored under,
 * which is what reuse detection deletes.
 */
function assignGrantFamilies(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.action !== "seal") continue;
    const pk = pairKey(item.rec);
    if (!pk) continue;
    let g = groups.get(pk);
    if (!g) groups.set(pk, (g = { access: [], refresh: [] }));
    if (item.k.kind === "access" || item.k.kind === "refresh") g[item.k.kind].push(item);
  }
  for (const g of groups.values()) {
    if (g.access.length !== 1 || g.refresh.length !== 1) continue;
    const fid = randomToken(16);
    const at = g.access[0];
    const rt = g.refresh[0];
    at.rec = { ...at.rec, fid };
    rt.rec = { ...rt.rec, fid, sibling_at: sha256hex(at.raw) };
    at.fid = fid;
    rt.fid = fid;
  }
}

async function scanAll(r, pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await r("SCAN", cursor, "MATCH", pattern, "COUNT", "500");
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== "0");
  return keys;
}

/**
 * Returns a report { mode, apply, sealed, deleted, skipped, unopenable,
 * v1Kept, aborted, actions[] }. actions entries are
 * { kind, key: "<sha256 prefix>", action }. `unopenable` > 0 means the run
 * wrote nothing and the CLI exits non-zero.
 */
export async function migrateLegacy(r, { apply = false, mode = "seal", log = () => {}, now = storageNow } = {}) {
  if (mode === "seal" && !loadKek()) throw new Error("seal mode requires LOGMEM_OAUTH_KEK (or use --delete)");
  const report = { mode, apply, sealed: 0, deleted: 0, skipped: 0, unopenable: 0, v1Kept: 0, aborted: false, actions: [] };
  const pastCutoff = now() >= LEGACY_CUTOFF_MS;

  // 1. Hashed-layout records: preflight (seal) or v1 cleanup plan (--delete).
  const hashedPlan = [];
  for (const k of HASHED_KINDS) {
    for (const key of await scanAll(r, `${k.prefix}*`)) {
      const h = key.slice(k.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(h)) continue;
      const rec = parse(await r("GET", key));
      if (!rec || !rec.creds || rec.creds.enc === "none") continue;
      const v1 = isV1Sealed(rec);
      const short = h.slice(0, 12);
      if (mode === "delete") {
        if (v1) hashedPlan.push({ kind: k.kind, key, short, action: "delete" });
        continue;
      }
      if (v1 && pastCutoff) continue; // cannot open by design any more; it just expires
      if (!canOpenRecord(rec, k.kind, h)) {
        report.unopenable++;
        report.actions.push({ kind: k.kind, key: short, action: "skip-unopenable" });
        log(`skip ${v1 ? "v1 " : ""}${k.kind} ${short}… (does not open with this KEK; NOT deleted)`);
      } else if (v1) {
        report.v1Kept++;
        report.actions.push({ kind: k.kind, key: short, action: "keep-v1" });
        log(`keep v1 ${k.kind} ${short}… (left to expire; re-auth after the cutoff)`);
      }
    }
  }
  if (report.unopenable > 0) {
    report.aborted = true;
    log(`aborted: ${report.unopenable} sealed record(s) do not open with LOGMEM_OAUTH_KEK. Check the KEK; nothing was written.`);
    return report;
  }

  // 2. Legacy raw-key records.
  // expires_at is wall-clock seconds; the storage clock only drives the legacy cutoff.
  const nowS = Math.floor(Date.now() / 1000);
  const legacy = [];
  for (const k of KINDS) {
    for (const key of await scanAll(r, `${k.prefix}*`)) {
      const raw = key.slice(k.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(raw)) continue; // lock keys, hashed-layout codes' :used, etc.
      const rec = parse(await r("GET", key));
      const short = sha256hex(raw).slice(0, 12);
      if (!rec || typeof rec !== "object" || rec.creds) {
        report.skipped++;
        continue; // already sealed (hashed-layout code) or not ours
      }
      const remaining = Number(await r("TTL", key));
      let ttl = remaining > 0 ? Math.min(remaining, k.ttl) : k.ttl;
      if (Number.isFinite(rec.expires_at)) ttl = Math.min(ttl, Math.floor(rec.expires_at) - nowS);
      const action = mode === "seal" && k.dest && ttl > 0 ? "seal" : "delete";
      legacy.push({ k, key, raw, rec, short, ttl, action });
    }
  }
  if (mode === "seal") assignGrantFamilies(legacy);
  for (const item of legacy) {
    report.actions.push({ kind: item.k.kind, key: item.short, action: item.action });
    log(`${apply ? "" : "[dry-run] "}${item.action} ${item.k.kind} ${item.short}…`);
    if (!apply) continue;
    if (item.action === "seal") {
      const h = sha256hex(item.raw);
      await r("SET", item.k.dest(h), JSON.stringify(sealRecord(item.rec, item.k.kind, h)), "EX", String(item.ttl));
      if (item.fid) {
        const member = item.k.kind === "access" ? `at:${h}` : `rt:${h}`;
        await r("SADD", KEY.family(item.fid), member);
        await r("EXPIRE", KEY.family(item.fid), String(TTL.refresh));
      }
      report.sealed++;
    } else {
      report.deleted++;
    }
    await r("DEL", item.key);
  }

  // 3. --delete only: v1 hashed records.
  for (const p of hashedPlan) {
    report.actions.push({ kind: p.kind, key: p.short, action: "delete" });
    log(`${apply ? "" : "[dry-run] "}delete v1 ${p.kind} ${p.short}…`);
    if (!apply) continue;
    await r("DEL", p.key);
    report.deleted++;
  }
  return report;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const mode = args.has("--delete") ? "delete" : "seal";
  const report = await migrateLegacy(deployRedis(), { apply, mode, log: (m) => console.log(m) });
  const { actions, ...summary } = report;
  console.log(JSON.stringify({ ...summary, planned: actions.length }));
  if (report.unopenable > 0) {
    console.error(`oauth-legacy-seal: ${report.unopenable} record(s) skipped because they do not open with this KEK; nothing written`);
    process.exitCode = 2;
    return;
  }
  if (!apply) console.log("dry run: nothing written. Re-run with --apply to execute.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`oauth-legacy-seal: ${e.message}`);
    process.exit(1);
  });
}
