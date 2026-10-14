// refs.mjs — what a recall `ref` is, and how to load the canonical entry it names.
//
// A ref is a pointer into the tenant's own Redis namespace. Two shapes:
//
//   Log entry   {logKey}@{score}#{id}
//               logKey  lm:t-{tenant}:{ns}:{id}:log  or  acmi:t-{tenant}:{ns}:{id}:timeline
//               score   the entry's raw ZSET score (ms for lm:*, whatever the
//                       legacy writer used for acmi:*), so lookup is one
//                       ZRANGEBYSCORE score score, not a scan of the log
//               id      the entry's trail (LogMem) / correlationId (ACMI); an
//                       entry with neither gets "h-" + 16 hex of sha256 of its
//                       stable JSON (minus the `_o` ordinal)
//
//   Document    the key itself, for string slots:
//               lm:t-{tenant}:*:who, lm:t-{tenant}:*:recap,
//               acmi:t-{tenant}:*:profile, acmi:t-{tenant}:*:rollup:latest
//
// Only the t-{tenant} namespace is accepted (see outbox.mjs); a bare
// lm:{tenant}: or acmi:{tenant}: ref is refused.
//
// Why score + id rather than {logKey}#{trail} alone: a ZSET member is the whole
// entry JSON, so finding one by trail means reading the entire log. The score
// narrows it to the handful of members in one millisecond; the id picks the
// one. Both are stable for the life of the entry, so the ref (and the point
// ids derived from it) stay the same across re-indexing and rebuilds.

import { createHash } from "node:crypto";
import { stableJson, tryParse, normTs } from "../../src/core/store.mjs";
import { asEntry, nsFromAcmi } from "../../src/core/vocab.mjs";
import { RecallError, refInTenant, checkTenant, tenantNs, MAX_REF } from "./outbox.mjs";
import { hasSecret } from "./redact.mjs";

const LOG_REF_RE = /^(.+:(?:log|timeline))@(-?\d+(?:\.\d+)?)#(.+)$/;
const DOC_SUFFIXES = [":who", ":recap", ":profile", ":rollup:latest"];
// Keys that are never recall material, even if a suffix happens to match.
// Only the namespace's top-level segment is checked: protected data lives at
// lm:t-{id}:{session|registry|ask|decision|oauth}:..., never deeper. A deeper
// segment named "oauth" (lm:t-{id}:agent:oauth:log) is an ordinary entity id.
const DENY_RE = /^(?:lm|acmi):[^:]+:(?:session|registry|ask|decision|oauth|outbox|cloud)(?::|$)/;

// MAX_TEXT bounds what is embedded; it is applied by the indexer AFTER redaction
// (prepareText in indexer.mjs), so a cut can never leave a secret fragment.
export const MAX_TEXT = 32 * 1024;

/** The stable id of one log member. */
export function entryId(member) {
  const parsed = tryParse(member);
  if (parsed && typeof parsed === "object") {
    const e = asEntry(parsed);
    const id = e.trail ?? e.correlationId;
    if (typeof id === "string" && id && id.length <= 200 && !id.includes("#") && !hasSecret(id)) return id;
    const { _o, ...rest } = parsed;
    return `h-${createHash("sha256").update(stableJson(rest)).digest("hex").slice(0, 16)}`;
  }
  return `h-${createHash("sha256").update(String(member)).digest("hex").slice(0, 16)}`;
}

export function logRef(key, score, member) {
  // Number() then String() so "1791731538741" and 1791731538741 give one ref.
  return `${key}@${String(Number(score))}#${entryId(member)}`;
}

export function parseRef(tenant, ref) {
  checkTenant(tenant);
  if (typeof ref !== "string" || !ref || ref.length > MAX_REF || !refInTenant(tenant, ref)) throw new RecallError("bad_ref", "invalid ref");
  const m = LOG_REF_RE.exec(ref);
  if (m) {
    const [, key, score, id] = m;
    if (DENY_RE.test(key) || !refInTenant(tenant, key)) throw new RecallError("bad_ref", "invalid ref");
    return { type: "log", key, score: Number(score), id };
  }
  if (DOC_SUFFIXES.some((s) => ref.endsWith(s)) && !DENY_RE.test(ref) && !ref.includes("#") && !ref.includes("@")) {
    return { type: "doc", key: ref };
  }
  throw new RecallError("bad_ref", "invalid ref");
}

/** Text the indexer embeds for one log entry (before redaction; uncapped). */
export function entryText(e) {
  const parts = [];
  for (const f of ["kind", "summary", "question", "action"]) if (e[f] != null && e[f] !== "") parts.push(`${f}: ${typeof e[f] === "string" ? e[f] : JSON.stringify(e[f])}`);
  if (e.payload !== undefined) parts.push(`payload: ${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`);
  return parts.join("\n");
}

const docKind = (key) => (key.endsWith(":rollup:latest") ? "recap" : key.endsWith(":profile") ? "who" : key.slice(key.lastIndexOf(":") + 1));

/**
 * Default loadEntry: read the canonical entry a ref names.
 * Returns { kind, ts_ms, text, entry } or null when it no longer exists.
 * Throws RecallError("bad_ref") for refs outside the tenant or of no known shape.
 */
export async function loadEntry(redis, tenant, ref) {
  const r = parseRef(tenant, ref);
  const type = String((await redis("TYPE", r.key)) || "none").toLowerCase();
  if (r.type === "log") {
    if (type !== "zset") return null;
    const rows = await redis("ZRANGEBYSCORE", r.key, r.score, r.score);
    for (const m of rows || []) {
      if (entryId(m) !== r.id) continue;
      const parsed = tryParse(m);
      const raw = parsed && typeof parsed === "object" ? parsed : { summary: String(m) };
      const { _o, ...entry } = asEntry(raw);
      if (entry.deleted === true || entry.tombstone === true) return null;
      return { kind: String(entry.kind ?? "memo"), ts_ms: normTs(entry.ts ?? r.score), text: entryText(entry), entry };
    }
    return null;
  }
  if (type !== "string") return null;
  const raw = await redis("GET", r.key);
  if (raw == null) return null;
  const doc = tryParse(raw);
  const ts = doc && typeof doc === "object" ? normTs(doc.updated_at ?? doc.ts ?? 0) : 0;
  return { kind: docKind(r.key), ts_ms: ts, text: typeof doc === "string" ? doc : JSON.stringify(doc), entry: doc };
}

/**
 * For a legacy acmi:t-{id}:{ns}:{eid}:timeline ref: the ref of the lm: copy of
 * the same entry (same id, same ms) if the migration made one, else null.
 * The lm: copy is canonical; the indexer and rebuild skip the acmi: twin.
 */
export async function lmTwinRef(redis, tenant, ref) {
  let r;
  try {
    r = parseRef(tenant, ref);
  } catch {
    return null;
  }
  if (r.type !== "log" || !r.key.startsWith("acmi:")) return null;
  const m = /^acmi:([^:]+):([^:]+):(.+):timeline$/.exec(r.key);
  if (!m) return null;
  const [, space, ens, eid] = m;
  const ts = normTs(r.score);
  for (const lns of new Set([nsFromAcmi(ens), ens])) {
    const key = `lm:${space}:${lns}:${eid}:log`;
    if (String((await redis("TYPE", key)) || "none").toLowerCase() !== "zset") continue;
    for (const member of (await redis("ZRANGEBYSCORE", key, ts, ts)) || []) {
      if (entryId(member) === r.id) return `${key}@${ts}#${r.id}`;
    }
  }
  return null;
}

/** Every canonical key pattern rebuild walks for a tenant. */
export function canonicalPatterns(tenant) {
  const ns = tenantNs(tenant);
  return [
    { match: `lm:${ns}:*:log`, type: "log" },
    { match: `acmi:${ns}:*:timeline`, type: "log" },
    { match: `lm:${ns}:*:who`, type: "doc" },
    { match: `lm:${ns}:*:recap`, type: "doc" },
    { match: `acmi:${ns}:*:profile`, type: "doc" },
    { match: `acmi:${ns}:*:rollup:latest`, type: "doc" },
  ];
}

export const isDeniedKey = (key) => DENY_RE.test(key);
