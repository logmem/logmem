// decide-resign.mjs: one-time migration after a LOGMEM_DECIDE_SECRET swap.
// Job decide-resign-migration, plan decide-key-recovery.
//
// A swap makes every decision signed with the old key stop verifying, so its
// ask shows as pending again. This re-signs, under the new key, only the
// decisions that:
//   - verify under the old key (a person really made them),
//   - were made before the swap cutoff (nothing new rides on the old key),
//   - settle (approve or reject; a defer never settles),
//   - still answer their ask unchanged (an altered ask is never migrated).
// It writes the set-once claim lm:{space}:decision:{trail} that readers take
// first. It never edits or removes a log entry. Dry run unless apply is true.

import { verifyDecision, signDecision, findAsk, SETTLES, DECIDE_SECRET_MIN } from "./tools.mjs";
import { lmDecisionKey } from "./keys.mjs";
import { CAS_LUA } from "./blockers.mjs";

const parse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};
const claimEntry = (rec) => (rec && typeof rec === "object" ? (rec.entry && typeof rec.entry === "object" ? rec.entry : rec.kind === "decided" ? rec : null) : null);


export class ResignError extends Error {}

function checkSecret(name, v) {
  if (typeof v !== "string" || v.length < DECIDE_SECRET_MIN) throw new ResignError(`${name} must be set (at least ${DECIDE_SECRET_MIN} characters)`);
}

/** Every decided entry by a person in the space's logs, grouped by the ask trail it answers. */
async function decidedByAsk(store) {
  const out = new Map();
  let cursor = "0";
  do {
    const [next, keys] = await store.redis("SCAN", cursor, "MATCH", `lm:${store.space}:*:log`, "COUNT", "1000");
    cursor = String(next);
    for (const k of keys) {
      const m = k.match(/^lm:[^:]+:([^:]+):([^:]+):log$/);
      if (!m) continue;
      let rows;
      try {
        rows = await store.readLog(m[1], m[2]);
      } catch {
        continue;
      }
      for (const e of rows) {
        if (!e || e.kind !== "decided" || typeof e.origin !== "string" || !/^human:/.test(String(e.by || ""))) continue;
        const list = out.get(e.origin) || [];
        list.push(e);
        out.set(e.origin, list);
      }
    }
  } while (cursor !== "0");
  return out;
}

/**
 * Re-sign pre-swap decisions. Returns counts plus the trails in each bucket.
 *   oldSecret, newSecret: the two keys (never logged)
 *   cutoff: ms; only decisions with ts < cutoff move
 *   apply: false (default) reads only
 */
export async function resignDecisions(store, { oldSecret, newSecret, cutoff, apply = false, now = Date.now } = {}) {
  checkSecret("old key", oldSecret);
  checkSecret("new key", newSecret);
  if (oldSecret === newSecret) throw new ResignError("old and new keys are the same; nothing to migrate");
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new ResignError("cutoff must be a positive ms timestamp");
  const space = store.space;
  const report = {
    mode: apply ? "apply" : "dry-run", space, cutoff,
    asks_with_decisions: 0,
    already_valid: [], resigned: [], altered: [], after_cutoff: [], unverifiable: [], defer_only: [], failed: [],
  };
  const byAsk = await decidedByAsk(store);
  // Claims can exist for an ask whose log rows were lost; include them too.
  let cursor = "0";
  do {
    const [next, keys] = await store.redis("SCAN", cursor, "MATCH", `lm:${space}:decision:*`, "COUNT", "1000");
    cursor = String(next);
    for (const k of keys) {
      const trail = k.slice(`lm:${space}:decision:`.length);
      if (trail && !byAsk.has(trail)) byAsk.set(trail, []);
    }
  } while (cursor !== "0");

  for (const [trail, rows] of [...byAsk].sort(([a], [b]) => a.localeCompare(b))) {
    report.asks_with_decisions++;
    let key;
    try {
      key = lmDecisionKey(space, trail);
    } catch {
      report.failed.push({ trail, why: "bad trail" });
      continue;
    }
    const raw = await store.redis("GET", key);
    const claim = claimEntry(parse(raw));
    if (claim && verifyDecision(claim, { secret: newSecret, space })) {
      report.already_valid.push(trail);
      continue;
    }
    // Candidates: the claim first (readers take it first), then log rows, earliest first.
    const candidates = [...(claim ? [claim] : []), ...[...rows].sort((a, b) => a.ts - b.ts)];
    const settling = candidates.filter((d) => SETTLES.includes(d.payload?.verdict));
    if (!settling.length) {
      report.defer_only.push(trail);
      continue;
    }
    const oldValid = settling.filter((d) => verifyDecision(d, { secret: oldSecret, space }));
    if (!oldValid.length) {
      report.unverifiable.push(trail);
      continue;
    }
    const pick = oldValid.find((d) => d.ts < cutoff);
    if (!pick) {
      report.after_cutoff.push(trail);
      continue;
    }
    // The ask must be the one that was signed. An altered or conflicting ask is never migrated.
    let found = null;
    try {
      found = await findAsk(store, trail, { secret: oldSecret });
    } catch {
      found = null;
    }
    if (!found || found.hash !== pick.payload?.ask_hash) {
      report.altered.push(trail);
      continue;
    }
    const p = pick.payload;
    const sig = signDecision({ space, origin: trail, ask_hash: p.ask_hash, verdict: p.verdict, note: p.note, by: pick.by, ts: pick.ts }, newSecret);
    const entry = { ...pick, payload: { ...p, sig }, resigned_at: now() };
    const value = JSON.stringify({ v: 3, origin: trail, verdict: p.verdict, note: p.note ?? null, by: pick.by, ts: pick.ts, ask_hash: p.ask_hash, sig, entry });
    if (!verifyDecision(entry, { secret: newSecret, space })) {
      report.failed.push({ trail, why: "re-signed entry did not verify" });
      continue;
    }
    if (apply) {
      const ok = raw == null ? (await store.redis("SET", key, value, "NX")) != null : (await store.redis("EVAL", CAS_LUA, 1, key, raw, value)) === "ok";
      if (!ok) {
        report.failed.push({ trail, why: "claim changed during the run" });
        continue;
      }
    }
    report.resigned.push(trail);
  }
  return report;
}

/** Counts only, safe to post: no trails' content, no keys. */
export const summarizeResign = (r) => ({
  mode: r.mode, space: r.space, cutoff: r.cutoff, asks_with_decisions: r.asks_with_decisions,
  ...Object.fromEntries(["already_valid", "resigned", "altered", "after_cutoff", "unverifiable", "defer_only", "failed"].map((k) => [k, r[k].length])),
});
