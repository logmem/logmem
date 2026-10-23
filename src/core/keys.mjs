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

/**
 * Ids an agent can't take: the web decider's id (LOGMEM_ADMIN_ID, default
 * "admin") and "human", so an agent can never share a name with the person
 * who answers its asks. ("human:<x>" is already refused by the charset.)
 */
export const reservedAgentIds = (env = process.env) => new Set([String(env.LOGMEM_ADMIN_ID || "admin").toLowerCase(), "human"]);

/** Validate an agent id ("quill" or "agent:quill"); returns the bare id or throws AgentIdError. */
export function checkAgentId(agent, field = "agent", env = process.env) {
  if (typeof agent !== "string") throw new AgentIdError(`${field} must be a string agent id`);
  const id = agent.replace(/^agent:/, "");
  if (!AGENT_ID_RE.test(id)) {
    throw new AgentIdError(`${field} must be 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit (got ${id.length} characters)`);
  }
  if (reservedAgentIds(env).has(id.toLowerCase())) {
    throw new AgentIdError(`${field} '${id}' is reserved for the person who answers asks; pick another agent id`);
  }
  return id;
}

/** The namespaces a reference can name. */
export const REF_NAMESPACES = ["agent", "channel", "job"];
/** Channel and job ids: letters, digits, '.', '_', '@', '+', '-', starting with a letter or digit. */
export const REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/;

function checkRefId(ns, id) {
  if (ns === "agent") return checkAgentId(id);
  validateKeySegments(id);
  if (!REF_ID_RE.test(id)) {
    throw new Error(`${ns} id '${id.slice(0, 64)}' is not valid: use letters, digits, '.', '_', '@', '+' or '-', starting with a letter or digit`);
  }
  return id;
}

/**
 * Parse an entity reference. Accepts "channel:field-notes", "job:issue-14",
 * "agent:quill", the ACMI forms "thread:x" / "work:x", or a bare id with a
 * default namespace. An unknown namespace or a malformed id is refused, so a
 * typo never reads or writes an empty record.
 */
export function parseRef(ref, defaultNs = "channel") {
  const s = String(ref ?? "").trim();
  if (!s) throw new Error("empty reference");
  const i = s.indexOf(":");
  if (i < 0) return { ns: defaultNs, id: checkRefId(defaultNs, s) };
  const rawNs = s.slice(0, i);
  const id = s.slice(i + 1);
  const ns = { thread: "channel", work: "job" }[rawNs] ?? rawNs;
  if (!REF_NAMESPACES.includes(ns)) {
    throw new Error(`unknown namespace '${rawNs.slice(0, 32)}': use agent:<id>, channel:<id> or job:<id>`);
  }
  if (!id) throw new Error(`empty ${ns} id`);
  return { ns, id: ns === "agent" ? checkAgentId(id) : checkRefId(ns, id) };
}

/**
 * The set-once settlement key for one ask: written with SET NX by
 * writeDecision, so an ask is approved or rejected exactly once.
 */
export function lmDecisionKey(space, trail) {
  validateKeySegments(space, trail);
  return `${PREFIX}:${space}:decision:${trail}`;
}

/**
 * The ask registry: one per ask, written with SET NX by logmem_ask and
 * holding the hash of the ask's canonical content. It is what makes an ask
 * canonical: any other approval entry under the same trail (a twin written
 * straight into a log, or a legacy acmi:* row) is ignored.
 */
export function lmAskKey(space, trail) {
  validateKeySegments(space, trail);
  return `${PREFIX}:${space}:ask:${trail}`;
}

/** Protected prefixes never removed by logmem_remove, even with confirm. Ask and decision keys stay: removing one would allow a second answer or a swapped ask. Usage counters stay so use cannot be erased. */
export const PROTECTED = [/^lm:[^:]+:registry:/, /^lm:oauth:/, /^lm:[^:]+:session:/, /^lm:[^:]+:decision:/, /^lm:[^:]+:ask:/, /^lm:[^:]+:usage:/];
