// keys.mjs — where LogMem keeps things.
//
//   lm:{space}:{ns}:{id}:{slot}
//
// Slots are the Concepts-tab words (Who / Now / Log). DRAFT until the
// tool-contract spec lands (2026-10-14); the migration dry-run reads
// LEGACY_SLOTS below to map acmi:{tenant}:* keys onto these.

import { validateKeySegments } from "../lib/helpers.mjs";
import { nsToAcmi } from "./vocab.mjs";

export const PREFIX = "lm";

export const SLOTS = {
  who: { type: "string", acmi: "profile" }, // JSON doc
  now: { type: "hash", acmi: "signals" }, // field -> JSON value
  log: { type: "zset", acmi: "timeline" }, // score = ts ms, member = entry JSON
  recap: { type: "string", acmi: "rollup:latest" }, // agents: last Recap
  follows: { type: "hash", acmi: "active_context" }, // agents: channel/job -> {role, joined_at}
  shifts: { type: "zset", acmi: "spawns" }, // agents: one per Start
  sessions: { type: "set", acmi: "sessions" }, // jobs: shift ids that touched it
};

export function lmKey(space, ns, id, slot) {
  validateKeySegments(space, ns, id);
  if (!Object.hasOwn(SLOTS, slot)) throw new Error(`unknown slot: ${slot}`);
  return `${PREFIX}:${space}:${ns}:${id}:${slot}`;
}

export function lmIndexKey(space, ns) {
  validateKeySegments(space, ns);
  return `${PREFIX}:${space}:${ns}:list`;
}

/** Session bookkeeping (auto Start / auto Recap). Not part of any entity. */
export function lmSessionKey(space, sessionId) {
  validateKeySegments(space, sessionId);
  return `${PREFIX}:${space}:session:${sessionId}`;
}

export function acmiKey(space, ns, id, slot) {
  return `acmi:${space}:${nsToAcmi(ns)}:${id}:${SLOTS[slot].acmi}`;
}

export function acmiIndexKey(space, ns) {
  return `acmi:${space}:${nsToAcmi(ns)}:list`;
}

// ─── Agent ids ──────────────────────────────────────────────────────────
// One rule everywhere an agent id enters (tools, compat tools, shifts,
// /api/inbox, /api/view): 1-64 characters, letters, digits, '.', '_', '-',
// starting with a letter or digit. An optional "agent:" prefix is allowed.
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class AgentIdError extends Error {
  constructor(message) {
    super(message);
    this.code = "bad_agent_id";
  }
}

/** Validate an agent id ("quill" or "agent:quill"); returns the bare id or throws AgentIdError. */
export function checkAgentId(agent, field = "agent") {
  if (typeof agent !== "string") throw new AgentIdError(`${field} must be a string agent id`);
  const id = agent.replace(/^agent:/, "");
  if (!AGENT_ID_RE.test(id)) {
    throw new AgentIdError(`${field} must be 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit (got ${id.length} characters)`);
  }
  return id;
}

/**
 * Parse an entity reference. Accepts "channel:field-notes", "job:issue-14",
 * "agent:quill", the ACMI forms "thread:x" / "work:x", or a bare id with a
 * default namespace.
 */
export function parseRef(ref, defaultNs = "channel") {
  const s = String(ref ?? "").trim();
  if (!s) throw new Error("empty reference");
  const i = s.indexOf(":");
  if (i < 0) {
    if (defaultNs === "agent") checkAgentId(s);
    return { ns: defaultNs, id: s };
  }
  const rawNs = s.slice(0, i);
  const id = s.slice(i + 1);
  const ns = { thread: "channel", work: "job" }[rawNs] ?? rawNs;
  validateKeySegments(ns, id);
  if (ns === "agent") checkAgentId(id);
  return { ns, id };
}

/**
 * The set-once settlement key for one ask: written with SET NX by
 * writeDecision, so an ask is approved or rejected exactly once.
 */
export function lmDecisionKey(space, trail) {
  validateKeySegments(space, trail);
  return `${PREFIX}:${space}:decision:${trail}`;
}

/** Protected prefixes never removed by logmem_remove, even with confirm. Decision keys stay: removing one would allow a second answer. */
export const PROTECTED = [/^lm:[^:]+:registry:/, /^lm:oauth:/, /^lm:[^:]+:session:/, /^lm:[^:]+:decision:/];
