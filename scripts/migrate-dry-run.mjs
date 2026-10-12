#!/usr/bin/env node
// migrate-dry-run.mjs — plan acmi:{space}:* -> lm:{space}:* and report counts.
//
// READ ONLY. The Redis runner is wrapped in an allowlist of read commands;
// anything else throws before it leaves the process. There is no --apply:
// writing the migration is a separate, HITL-gated change (Mikey).
//
//   LOGMEM_REST_URL=https://.../bridge/exec LOGMEM_REST_TOKEN=... node scripts/migrate-dry-run.mjs
//   LOGMEM_REDIS_URI=redis://... node scripts/migrate-dry-run.mjs --space madez --out report.json
//
// What it plans, per key:
//   profile        STRING JSON   -> who     STRING JSON
//   signals        STRING JSON   -> now     HASH  (one field per top-level key)
//   timeline       ZSET          -> log     ZSET  (score -> ms, entry -> LogMem shape)
//   rollup:latest  STRING JSON   -> recap
//   active_context HASH|STRING   -> follows HASH  (thread:x -> channel:x)
//   spawns         ZSET          -> shifts  ZSET  (score -> ms)
//   sessions       SET           -> sessions
//   {ns}:list      SET|STRING|.. -> lm:{space}:{ns}:list SET
// Anything else is reported as unmapped, with examples, and left alone.

import { writeFileSync } from "node:fs";
import { SLOTS } from "../src/core/keys.mjs";
import { nsFromAcmi, entryFromAcmi, kindFromAcmi } from "../src/core/vocab.mjs";
import { normTs, tryParse } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
if (argv.includes("--apply")) {
  console.error("refused: --apply is not implemented. Migration writes are HITL (Mikey) and ship as a separate PR.");
  process.exit(2);
}
const SPACE = arg("space", process.env.LOGMEM_SPACE || "madez");
const OUT = arg("out", null);

import { readOnly } from "../src/lib/read-only.mjs";
export { readOnly };

// ─── key parsing ────────────────────────────────────────────────────
const ACMI_SLOTS = Object.entries(SLOTS).map(([lm, d]) => ({ lm, acmi: d.acmi, type: d.type }));
// longest suffix first so "rollup:latest" wins over a bare id
ACMI_SLOTS.sort((a, b) => b.acmi.length - a.acmi.length);

export function planKey(key, space) {
  const prefix = `acmi:${space}:`;
  if (!key.startsWith(prefix)) return { unmapped: "other-space" };
  const rest = key.slice(prefix.length);
  const parts = rest.split(":");
  if (parts.length === 2 && parts[1] === "list") {
    return { kind: "index", ns: nsFromAcmi(parts[0]), target: `lm:${space}:${nsFromAcmi(parts[0])}:list` };
  }
  for (const s of ACMI_SLOTS) {
    if (!rest.endsWith(`:${s.acmi}`)) continue;
    const head = rest.slice(0, -(s.acmi.length + 1)).split(":");
    if (head.length !== 2) return { unmapped: head.length < 2 ? "no-id" : "id-has-colon", slot: s.acmi };
    const [ns, id] = head;
    if (!ns || !id || id.length > 200) return { unmapped: "bad-segment", slot: s.acmi };
    const lmNs = nsFromAcmi(ns);
    return { kind: "slot", ns: lmNs, acmiNs: ns, id, slot: s.lm, acmiSlot: s.acmi, expect: s.type, target: `lm:${space}:${lmNs}:${id}:${s.lm}` };
  }
  return { unmapped: "unknown-slot" };
}

function unitOf(score) {
  const x = Number(score);
  if (x > 1e17) return "ns";
  if (x > 1e14) return "us";
  if (x >= 1e9 && x < 1e11) return "s";
  if (x >= 1e11) return "ms";
  return "small";
}

const bump = (o, k, n = 1) => (o[k] = (o[k] || 0) + n);
const top = (o, n = 25) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);

// ─── main ───────────────────────────────────────────────────────────
export async function dryRun(redis, space) {
  const r = readOnly(redis);
  const report = {
    mode: "DRY-RUN",
    writes: 0,
    space,
    started_at: new Date().toISOString(),
    db_keys_total: Number(await r("DBSIZE")),
    scanned: 0,
    mapped: 0,
    by_target_slot: {},
    by_ns: {},
    type_mismatch: {},
    unmapped: {},
    unmapped_examples: {},
    targets_already_present: 0,
    entries: { total: 0, unparseable: 0, kinds_remapped: 0, kinds_alias_preserved: 0, kinds_unknown_passthrough: 0, fields_renamed: 0, rescored: 0, collisions_after_rescore: 0 },
    score_units: {},
    kinds_remapped: {},
    kinds_unknown: {},
    now_fields: 0,
    rescored_by_key: {},
    timeline_as_string: [],
  };

  let cursor = "0";
  const keys = [];
  do {
    const [next, batch] = await r("SCAN", cursor, "MATCH", `acmi:${space}:*`, "COUNT", "1000");
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== "0");
  const unique = [...new Set(keys)].sort();
  report.scanned = unique.length;

  for (const key of unique) {
    const plan = planKey(key, space);
    if (plan.unmapped) {
      bump(report.unmapped, plan.unmapped);
      (report.unmapped_examples[plan.unmapped] ||= []).length < 8 && report.unmapped_examples[plan.unmapped].push(key);
      continue;
    }
    report.mapped++;
    bump(report.by_target_slot, plan.kind === "index" ? "list" : plan.slot);
    bump(report.by_ns, plan.ns);
    if (Number(await r("EXISTS", plan.target)) === 1) report.targets_already_present++;
    if (plan.kind === "index") continue;

    const type = String(await r("TYPE", key)).toLowerCase();
    const okType = type === plan.expect || (plan.slot === "now" && type === "string") || (plan.slot === "follows" && type === "string");
    if (!okType) bump(report.type_mismatch, `${plan.acmiSlot}:${type}`);

    if (plan.slot === "now" && type === "string") {
      const v = tryParse(await r("GET", key));
      if (v && typeof v === "object" && !Array.isArray(v)) report.now_fields += Object.keys(v).length;
    }

    if ((plan.slot === "log" || plan.slot === "shifts") && type === "string") {
      const v = tryParse(await r("GET", key));
      report.timeline_as_string.push({ key, parsed: Array.isArray(v) ? `array(${v.length})` : typeof v });
    }

    if ((plan.slot === "log" || plan.slot === "shifts") && type === "zset") {
      const flat = await r("ZRANGE", key, "0", "-1", "WITHSCORES");
      const seen = new Set();
      let rescoredHere = 0;
      for (let i = 0; i < flat.length; i += 2) {
        const member = flat[i];
        const score = Number(flat[i + 1]);
        const unit = unitOf(score);
        bump(report.score_units, unit);
        const ms = normTs(score);
        if (ms !== Math.floor(score)) rescoredHere++;
        report.entries.total++;
        const ev = tryParse(member);
        if (!ev || typeof ev !== "object") {
          report.entries.unparseable++;
          continue;
        }
        if (plan.slot === "log") {
          for (const f of ["correlationId", "parentCorrelationId", "source", "tenant_id", "speaker_type"]) if (f in ev) report.entries.fields_renamed++;
          if (ev.kind != null) {
            const k = kindFromAcmi(ev.kind);
            if (k.kind !== ev.kind) {
              report.entries.kinds_remapped++;
              bump(report.kinds_remapped, `${ev.kind} -> ${k.kind}`);
              if (k.acmi_kind) report.entries.kinds_alias_preserved++;
            } else {
              report.entries.kinds_unknown_passthrough++;
              bump(report.kinds_unknown, String(ev.kind));
            }
          }
          const out = entryFromAcmi({ ...ev, ts: normTs(ev.ts ?? score) });
          const sig = `${ms}|${JSON.stringify(out)}`;
          if (seen.has(sig)) report.entries.collisions_after_rescore++;
          seen.add(sig);
        }
      }
      report.entries.rescored += rescoredHere;
      if (rescoredHere) report.rescored_by_key[key] = rescoredHere;
    }
  }

  report.rescored_top_keys = top(report.rescored_by_key);
  delete report.rescored_by_key;
  report.kinds_remapped = top(report.kinds_remapped, 40);
  report.kinds_unknown_top = top(report.kinds_unknown, 40);
  report.kinds_unknown_distinct = Object.keys(report.kinds_unknown).length;
  delete report.kinds_unknown;
  report.finished_at = new Date().toISOString();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = descriptorFromEnv();
  if (!d) {
    console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
    process.exit(1);
  }
  const report = await dryRun(fromDescriptor(d).redis, SPACE);
  const text = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, text);
  console.log(text);
}
