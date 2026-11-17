// drafts.mjs — hold state for Ask the record / approach C.
//
// A draft is never in the live ask queue and never in Brief pending_asks.
// Key: lm:{space}:draft:{personBare}:{draftId}  (personBare = id without human:)
// Index: lm:{space}:draft:{personBare}:index     (SET of draft ids)
//
// Spec: docs/superpowers/specs/2026-11-06-builtin-drafting-agent-design.md §5.4

import { randomBytes } from "node:crypto";
import { lmDraftKey, lmDraftIndexKey } from "./keys.mjs";

export const DRAFT_TTL_S = 30 * 24 * 60 * 60; // 30 days (Mikey default)
export const DRAFT_KINDS = ["ask", "note"];
export const DRAFT_STATUSES = ["draft", "sent", "discarded"];

export class DraftError extends Error {
  constructor(message, code = "bad_request") {
    super(message);
    this.name = "DraftError";
    this.code = code;
  }
}

/** Bare person id for Redis key segments (no colon). */
export function personBare(person) {
  const s = String(person || "").trim();
  const bare = s.startsWith("human:") ? s.slice(6) : s.startsWith("agent:") ? s.slice(6) : s;
  if (!bare || bare.includes(":")) throw new DraftError("person id is not valid for draft keys");
  return bare;
}

export function newDraftId(now = Date.now()) {
  return `d_${now}_${randomBytes(4).toString("hex")}`;
}

function parseJson(raw) {
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Create a draft. Forces reversible false on ask drafts.
 * redis is an async (cmd, ...args) => result runner (store.redis).
 */
export async function createDraft(redis, {
  space,
  person,
  kind,
  ask,
  note,
  sources = [],
  created_by = "agent:logmem-drafter",
  model_call = null,
  ttlS = DRAFT_TTL_S,
  now = Date.now(),
} = {}) {
  if (!DRAFT_KINDS.includes(kind)) throw new DraftError("kind must be ask or note");
  const forPerson = String(person || "");
  if (!forPerson.startsWith("human:")) throw new DraftError("drafts are for a person (human:<id>)");
  const bare = personBare(forPerson);
  const id = newDraftId(typeof now === "function" ? now() : now);
  const ts = typeof now === "function" ? now() : now;

  let body = { id, kind, space, for: forPerson, created_by, created_at: ts, model_call, sources, status: "draft" };
  if (kind === "ask") {
    const question = String(ask?.question || "");
    const action = String(ask?.action || "");
    if (!question || question.length > 1000) throw new DraftError(`question required, max ${1000} characters`);
    if (!action || action.length > 4000) throw new DraftError(`action required, max ${4000} characters`);
    body.ask = {
      question,
      action,
      reversible: false, // model / draft path cannot set true
      where: ask?.where || undefined,
      // Optional receiver. Do not default to forPerson: Send registers the
      // person as asker, and writeDecision forbids asker self-approve (OQ8 Phase 2).
      ...(ask?.to ? { to: ask.to } : {}),
    };
  } else {
    const summary = String(note?.summary || "");
    if (!summary || summary.length > 1000) throw new DraftError(`note summary required, max ${1000} characters`);
    body.note = { channel: note?.channel || undefined, summary };
  }

  const key = lmDraftKey(space, bare, id);
  const idx = lmDraftIndexKey(space, bare);
  await redis("SET", key, JSON.stringify(body), "EX", ttlS);
  await redis("SADD", idx, id);
  await redis("EXPIRE", idx, ttlS);
  return body;
}

export async function getDraft(redis, { space, person, draftId }) {
  const bare = personBare(person);
  const raw = await redis("GET", lmDraftKey(space, bare, draftId));
  return parseJson(raw);
}

export async function listDrafts(redis, { space, person }) {
  const bare = personBare(person);
  const ids = (await redis("SMEMBERS", lmDraftIndexKey(space, bare))) || [];
  const out = [];
  for (const id of ids) {
    const d = parseJson(await redis("GET", lmDraftKey(space, bare, id)));
    if (d && d.status === "draft") out.push(d);
  }
  return out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export async function updateDraft(redis, { space, person, draftId, ask, note, ttlS = DRAFT_TTL_S }) {
  const d = await getDraft(redis, { space, person, draftId });
  if (!d) throw new DraftError("draft not found", "not_found");
  if (d.status !== "draft") throw new DraftError("draft was already sent or discarded", "not_draft");
  if (ask) {
    if (d.kind !== "ask") throw new DraftError("not an ask draft");
    if (ask.question != null) {
      const q = String(ask.question);
      if (!q || q.length > 1000) throw new DraftError(`question max ${1000}`);
      d.ask.question = q;
    }
    if (ask.action != null) {
      const a = String(ask.action);
      if (!a || a.length > 4000) throw new DraftError(`action max ${4000}`);
      d.ask.action = a;
    }
    // reversible cannot be set true here via model; person flip is UI-only later
  }
  if (note) {
    if (d.kind !== "note") throw new DraftError("not a note draft");
    if (note.summary != null) {
      const s = String(note.summary);
      if (!s || s.length > 1000) throw new DraftError(`summary max ${1000}`);
      d.note.summary = s;
    }
  }
  const bare = personBare(person);
  const key = lmDraftKey(space, bare, draftId);
  await redis("SET", key, JSON.stringify(d), "EX", ttlS);
  return d;
}

export async function discardDraft(redis, { space, person, draftId, ttlS = DRAFT_TTL_S }) {
  const d = await getDraft(redis, { space, person, draftId });
  if (!d) throw new DraftError("draft not found", "not_found");
  if (d.status !== "draft") throw new DraftError("draft was already sent or discarded", "not_draft");
  d.status = "discarded";
  const bare = personBare(person);
  await redis("SET", lmDraftKey(space, bare, draftId), JSON.stringify(d), "EX", ttlS);
  return d;
}

export async function markDraftSent(redis, { space, person, draftId, trail, ttlS = DRAFT_TTL_S }) {
  const d = await getDraft(redis, { space, person, draftId });
  if (!d) throw new DraftError("draft not found", "not_found");
  if (d.status !== "draft") throw new DraftError("draft was already sent or discarded", "not_draft");
  d.status = "sent";
  d.sent_trail = trail;
  const bare = personBare(person);
  await redis("SET", lmDraftKey(space, bare, draftId), JSON.stringify(d), "EX", ttlS);
  return d;
}
