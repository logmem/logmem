// links.mjs — a job and the tasks and decisions waiting on a person.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-work-taxonomy-design.md, "Auto-link".
// Creating a task or a decision on a job sets the job to blocked, with
// blocked_on pointing at it. When every open one is answered, the job goes
// back to active. Reject and Can't do mark it needs_new_path so the agent
// picks another way. Defer leaves it blocked.
//
// State lives on the job's Now: waits (list of { type, ref, note }),
// blocked_on (the first open one), stage, and last_outcome.

export const BLOCKED_TYPES = ["decision", "task", "agent", "external"];
const OUTCOMES = { approve: false, done: false, reject: true, cant_do: true };

export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
  }
}

/** A clean blocked_on, or a thrown BlockedError a model can act on. */
export function checkBlockedOn(b) {
  const example = '{ "type": "agent", "ref": "codex", "note": "Waiting on the review of PR 64" }';
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new BlockedError(`blocked needs blocked_on: what the job waits on, e.g. ${example}`);
  if (!BLOCKED_TYPES.includes(b.type)) throw new BlockedError(`blocked_on.type must be one of ${BLOCKED_TYPES.join(", ")}`);
  if (typeof b.note !== "string" || !b.note.trim()) throw new BlockedError(`blocked_on.note must say in one line what is needed, e.g. ${example}`);
  if (b.note.length > 300) throw new BlockedError("blocked_on.note is longer than 300 characters");
  if (b.ref != null && (typeof b.ref !== "string" || b.ref.length > 200)) throw new BlockedError("blocked_on.ref must be a trail or an agent id");
  if (b.parked != null && typeof b.parked !== "boolean") throw new BlockedError("blocked_on.parked must be true or false");
  if (b.until != null && (typeof b.until !== "string" || b.until.length > 200)) throw new BlockedError("blocked_on.until must be text: when the job can move again");
  // Parked (lanes spec): waits on purpose, not stuck. It shows under Parked, not Blocked.
  return { type: b.type, ...(b.ref ? { ref: b.ref } : {}), note: b.note.trim(), ...(b.parked === true ? { parked: true } : {}), ...(b.until ? { until: b.until.trim() } : {}) };
}

const waitsOf = (now) => (Array.isArray(now?.waits) ? now.waits : []);

/** A task or decision was just created on job `id`: block the job on it. */
export async function linkOpen(store, id, { type, ref, note, now = Date.now }) {
  const cur = await store.getNow("job", id);
  const waits = waitsOf(cur).filter((w) => w.ref !== ref);
  const w = { type, ref, note: String(note || "").slice(0, 300) };
  waits.push(w);
  return store.setNow("job", id, { stage: "blocked", stage_at: now(), blocked_on: waits[0], waits });
}

/**
 * A task or decision on job `id` was answered. outcome: approve, reject,
 * done or cant_do. Returns the job's new Now, or null if nothing linked.
 */
export async function linkClose(store, id, { ref, outcome, now = Date.now }) {
  if (!id) return null;
  const cur = await store.getNow("job", id);
  const before = waitsOf(cur);
  if (!before.some((w) => w.ref === ref)) return null;
  const waits = before.filter((w) => w.ref !== ref);
  const last = { ref, outcome, at: now(), needs_new_path: OUTCOMES[outcome] === true };
  if (waits.length) return store.setNow("job", id, { blocked_on: waits[0], waits, last_outcome: last });
  const stillBlocked = cur.stage === "blocked" && cur.blocked_on && !before.some((w) => w.ref === cur.blocked_on.ref);
  return store.setNow("job", id, {
    waits: [],
    last_outcome: last,
    ...(stillBlocked ? {} : { stage: cur.stage === "done" ? "done" : "active", stage_at: now(), blocked_on: null }),
  });
}

/** The job id behind a where ref like "job:jail", or null for any other log. */
export function jobOf(where) {
  const m = /^job:(.+)$/.exec(String(where || ""));
  return m ? m[1] : null;
}
