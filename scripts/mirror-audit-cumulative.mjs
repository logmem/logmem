#!/usr/bin/env node
// mirror-audit-cumulative.mjs — Q2 read-only diagnostics (opencode, 2026-10-30).
//
// The daily dogfood-check counts one 24h window. Codex asked for the
// cumulative backlog with bounded classifications:
//   required_missing_twins : policy says mirror on (or unknown), twin absent
//   explicit_opt_outs      : stamped mirror: "off" — reported, never a failure
//   unknown_metadata       : policy cannot be determined from entry or shift
// plus writer-policy histogram and mirror retry depth.
//
// READ-ONLY: no writes of any kind. Prints one JSON receipt to stdout.
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/mirror-audit-cumulative.mjs [--space madez]
import { createStore, tryParse } from "../src/core/store.mjs";
import { acmiKey } from "../src/core/keys.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

const space = (process.argv.includes("--space") ? process.argv[process.argv.indexOf("--space") + 1] : "madez");
const d = descriptorFromEnv();
if (!d) { console.error("set LOGMEM_REST_URL + LOGMEM_REST_TOKEN"); process.exit(1); }
const redis = fromDescriptor(d).redis;
const store = createStore(redis, { space, compat: false });

const safeRedis = async (op, ...args) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await redis(op, ...args);
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
};
const scan = async (pat) => { const out = []; let cur = "0"; do { const r = await safeRedis("SCAN", cur, "MATCH", pat, "COUNT", "1000"); out.push(...r[1]); cur = r[0]; } while (cur !== "0"); return out; };
const parseLogKey = (key) => { const parts = key.split(":"); return { ns: parts[2], id: parts[3] }; };

// Twin check identical to dogfood-check: same ts score, correlationId + summary.
const acmiRows = async (key, from, to) => {
  const rows = (await safeRedis("ZRANGEBYSCORE", key, from, to)) || [];
  return rows.map(tryParse).filter(Boolean);
};
const shiftCache = new Map();
const entryMirror = async (e) => {
  if (Object.hasOwn(e, "mirror")) return ["on", "off"].includes(e.mirror) ? e.mirror : null;
  const m = String(e.shift || "").match(/Shift-(\d+)-[0-9a-f]+$/);
  if (!m || !String(e.by || "").startsWith("agent:")) return null;
  if (!shiftCache.has(e.shift)) {
    try {
      const rows = (await redis("ZRANGEBYSCORE", store.key("agent", e.by.slice(6), "shifts"), m[1], m[1])) || [];
      const rec = rows.map(tryParse).find((r) => r && r.shift === m[1]);
      shiftCache.set(e.shift, rec && ["on", "off"].includes(rec.mirror) ? rec.mirror : null);
    } catch (err) {
      shiftCache.set(e.shift, null);
      if (globalThis.__shiftErrors && globalThis.__shiftErrors.length < 5)
        globalThis.__shiftErrors.push({ by: e.by, shift: e.shift, why: String(err?.message || err).slice(0, 100) });
    }
  }
  return shiftCache.get(e.shift);
};

globalThis.__shiftErrors = [];
const started = Date.now();
const logKeys = (await scan(`lm:${space}:*:log`)).map((k) => ({ key: k, ...parseLogKey(k) })).filter((x) => x.ns);
const out = {
  kind: "mirror-cumulative-audit", space, ran_at: new Date().toISOString(),
  log_keys: logKeys.length, entries_total: 0,
  policy: { on: 0, off: 0, unknown: 0 },
  outcome: { twins_ok: 0, required_missing_twins: 0, explicit_opt_outs: 0, unknown_metadata: 0 },
  writers: { on: {}, off: {}, unknown: {} },
  mismatch_examples: [], parse_failures: 0,
};
const bump = (bag, by) => { const k = String(by || "unknown"); bag[k] = (bag[k] || 0) + 1; };
let done = 0;
for (const { ns, id } of logKeys) {
  const entries = await store.readLog(ns, id, { sinceMs: 0, untilMs: Date.now() });
  const twinKey = acmiKey(space, ns, id, "log");
  let twinType = "none";
  try {
    twinType = String((await safeRedis("TYPE", twinKey)) || "none").toLowerCase();
  } catch (err) {
    out.parse_failures++;
    if (out.mismatch_examples.length < 10) out.mismatch_examples.push({ log: `${ns}:${id}`, why: `TYPE query failed: ${err.message}` });
  }
  for (const e of entries) {
    out.entries_total++;
    const policy = await entryMirror(e);
    const p = policy === "on" ? "on" : policy === "off" ? "off" : "unknown";
    out.policy[p]++;
    bump(out.writers[p], e.by);
    if (p === "off") { out.outcome.explicit_opt_outs++; continue; } // stamped opt-out: no twin expected
    if (e.ts == null) { out.parse_failures++; if (out.mismatch_examples.length < 10) out.mismatch_examples.push({ log: `${ns}:${id}`, why: "entry without ts", trail: e.trail }); continue; }
    if (twinType !== "zset" && twinType !== "none") {
      out.parse_failures++;
      if (out.mismatch_examples.length < 10) out.mismatch_examples.push({ log: `${ns}:${id}`, why: `twin key is ${twinType}, not zset` });
      continue;
    }
    let twins;
    try { twins = await acmiRows(twinKey, e.ts, e.ts); }
    catch (err) {
      out.parse_failures++;
      if (out.mismatch_examples.length < 10) out.mismatch_examples.push({ log: `${ns}:${id}`, why: "twin query failed", ts: e.ts, ts_type: typeof e.ts });
      continue;
    }
    const ok = twins.some((t) => t.correlationId === e.trail && t.summary === e.summary);
    if (ok) out.outcome.twins_ok++;
    else if (p === "on") {
      out.outcome.required_missing_twins++;
      if (out.mismatch_examples.length < 10) out.mismatch_examples.push({ log: `${ns}:${id}`, ts: e.ts, trail: e.trail, by: e.by });
    } else out.outcome.unknown_metadata++;
  }
  done++;
  if (done % 100 === 0) process.stderr.write(`  ${done}/${logKeys.length} log keys\n`);
}
const retryDepth = Number(await redis("ZCARD", `${space === "madez" ? "madez" : space}:mirror:retry`.replace(/^/, "lm:")) || 0);
out.retry = { depth: retryDepth };
if (retryDepth > 0) {
  const oldest = (await redis("ZRANGE", `lm:${space}:mirror:retry`, 0, 0, "WITHSCORES")) || [];
  if (oldest.length >= 2) out.retry.oldest_age_sec = Math.round((Date.now() - Number(oldest[1])) / 1000);
}
out.elapsed_s = Math.round((Date.now() - started) / 1000);
out.shift_lookup_errors = globalThis.__shiftErrors;
console.log(JSON.stringify(out, null, 1));
