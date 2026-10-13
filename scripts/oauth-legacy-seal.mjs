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
// Also re-seals records already in the hashed layout whose envelope is still
// v1 (constant AAD, sealed before record binding): lm:oauth:at:* and
// lm:oauth:rt:* are opened with the v1 AAD and re-sealed with the v2
// record-bound AAD, keeping the remaining TTL. v1 envelopes stop opening at
// LEGACY_CUTOFF_MS, so run this before then. Codes (10 min) and grace records
// (60 s) are not worth migrating. In --delete mode v1 records are deleted.
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
import { KEY, TTL, deployRedis, loadKek, parse, sealRecord, sha256hex, isV1Sealed, resealV1Record } from "../api/oauth/_lib/storage.mjs";

const KINDS = [
  { kind: "access", prefix: "lm:oauth:token:", dest: KEY.access, ttl: TTL.access },
  { kind: "refresh", prefix: "lm:oauth:refresh:", dest: KEY.refresh, ttl: TTL.refresh },
  { kind: "code", prefix: "lm:oauth:code:", dest: null, ttl: TTL.code },
];
// Hashed-layout prefixes whose v1 envelopes get re-sealed as v2.
const V1_KINDS = [
  { kind: "access", prefix: "lm:oauth:at:", ttl: TTL.access },
  { kind: "refresh", prefix: "lm:oauth:rt:", ttl: TTL.refresh },
];

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
 * Returns a report { mode, apply, sealed, deleted, skipped, actions[] }.
 * actions entries are { kind, key: "<sha256 prefix>", action }.
 */
export async function migrateLegacy(r, { apply = false, mode = "seal", log = () => {} } = {}) {
  if (mode === "seal" && !loadKek()) throw new Error("seal mode requires LOGMEM_OAUTH_KEK (or use --delete)");
  const report = { mode, apply, sealed: 0, resealed: 0, deleted: 0, skipped: 0, actions: [] };
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
      const action = mode === "seal" && k.dest ? "seal" : "delete";
      report.actions.push({ kind: k.kind, key: short, action });
      log(`${apply ? "" : "[dry-run] "}${action} ${k.kind} ${short}…`);
      if (!apply) continue;
      if (action === "seal") {
        const remaining = Number(await r("TTL", key));
        const ttl = remaining > 0 ? remaining : k.ttl;
        const h = sha256hex(raw);
        await r("SET", k.dest(h), JSON.stringify(sealRecord(rec, k.kind, h)), "EX", String(ttl));
        report.sealed++;
      } else {
        report.deleted++;
      }
      await r("DEL", key);
    }
  }
  for (const k of V1_KINDS) {
    for (const key of await scanAll(r, `${k.prefix}*`)) {
      const h = key.slice(k.prefix.length);
      if (!/^[0-9a-f]{64}$/.test(h)) continue;
      const rec = parse(await r("GET", key));
      if (!isV1Sealed(rec)) continue; // v2 already, or not ours
      const short = h.slice(0, 12);
      const next = mode === "seal" ? resealV1Record(rec, k.kind, h) : null;
      // Unopenable (wrong KEK / past cutoff) or --delete: the record is dead weight.
      const action = next ? "reseal" : "delete";
      report.actions.push({ kind: k.kind, key: short, action });
      log(`${apply ? "" : "[dry-run] "}${action} v1 ${k.kind} ${short}…`);
      if (!apply) continue;
      if (next) {
        const remaining = Number(await r("TTL", key));
        await r("SET", key, JSON.stringify(next), "EX", String(remaining > 0 ? remaining : k.ttl));
        report.resealed++;
      } else {
        await r("DEL", key);
        report.deleted++;
      }
    }
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
  if (!apply) console.log("dry run: nothing written. Re-run with --apply to execute.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`oauth-legacy-seal: ${e.message}`);
    process.exit(1);
  });
}
