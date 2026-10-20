// blockers.mjs — work handed to a person, with a step-by-step walkthrough.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-blockers-plans-design.md.
// An agent hands work to a person with logmem_handoff to "human:<id>". The
// handoff entry goes on the job or channel log, as usual, and a record keeps
// the walkthrough and the person's progress:
//   lm:{space}:blocker:{trail}   — { trail, to, by, where, summary, walkthrough, steps_done, done, ... }
//   lm:{space}:blocker:open      — SET of open trails
// Only the web app (a signed-in person) ticks steps or marks one done. Each
// tick and the done also write an entry by that person on the work's log, so
// agents see progress in their Brief and in the log.

import { tryParse } from "./store.mjs";
import { linkClose, jobOf } from "./links.mjs";

export const PERSON_RE = /^human:[a-z0-9][a-z0-9_.-]{0,63}$/;
export const WALKTHROUGH_LIMITS = { steps: 20, title: 120, detail: 1000, cmd: 500, field: 300 };
const TRAIL_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export class BlockerError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockerError";
  }
}

const K = {
  rec: (space, trail) => `lm:${space}:blocker:${trail}`,
  open: (space) => `lm:${space}:blocker:open`,
};

const str = (v, max, field) => {
  if (v == null || v === "") return undefined;
  if (typeof v !== "string") throw new BlockerError(`walkthrough ${field} must be text`);
  if (v.length > max) throw new BlockerError(`walkthrough ${field} is longer than ${max} characters`);
  return v;
};

/** A clean walkthrough, or undefined. Throws on bad shapes so the agent can fix the call. */
export function normalizeWalkthrough(w) {
  if (w == null) return undefined;
  if (typeof w !== "object" || Array.isArray(w)) throw new BlockerError("walkthrough must be an object");
  const L = WALKTHROUGH_LIMITS;
  const steps = w.steps == null ? [] : w.steps;
  if (!Array.isArray(steps)) throw new BlockerError("walkthrough steps must be a list");
  if (steps.length > L.steps) throw new BlockerError(`a walkthrough has at most ${L.steps} steps`);
  return {
    steps: steps.map((s, i) => {
      if (!s || typeof s !== "object") throw new BlockerError(`walkthrough step ${i + 1} must be an object`);
      const title = str(s.title, L.title, `step ${i + 1} title`);
      if (!title) throw new BlockerError(`walkthrough step ${i + 1} needs a title`);
      return { title, ...(s.detail ? { detail: str(s.detail, L.detail, `step ${i + 1} detail`) } : {}), ...(s.cmd ? { cmd: str(s.cmd, L.cmd, `step ${i + 1} cmd`) } : {}) };
    }),
    ...(w.time ? { time: str(w.time, L.field, "time") } : {}),
    ...(w.place ? { place: str(w.place, L.field, "place") } : {}),
    ...(w.done_when ? { done_when: str(w.done_when, L.field, "done_when") } : {}),
    ...(w.reply ? { reply: str(w.reply, L.detail, "reply") } : {}),
    ...(w.due ? { due: str(w.due, L.field, "due") } : {}),
  };
}

export async function createBlocker(store, rec) {
  if (!TRAIL_RE.test(String(rec.trail || ""))) throw new BlockerError("trail is not valid");
  const ok = await store.redis("SET", K.rec(store.space, rec.trail), JSON.stringify({ ...rec, steps_done: [], done: false }), "NX");
  if (ok !== "OK") throw new BlockerError(`a blocker with trail '${rec.trail}' already exists`);
  await store.redis("SADD", K.open(store.space), rec.trail);
}

export async function getBlocker(store, trail) {
  if (!TRAIL_RE.test(String(trail || ""))) return null;
  const rec = tryParse(await store.redis("GET", K.rec(store.space, trail)));
  return rec && typeof rec === "object" && rec.trail === trail ? rec : null;
}

/** Open blockers, optionally only those for one person or from one agent. Oldest first. */
export async function listBlockers(store, { to, by } = {}) {
  const out = [];
  for (const trail of (await store.redis("SMEMBERS", K.open(store.space))) || []) {
    const rec = await getBlocker(store, trail);
    if (!rec || rec.done) continue;
    if (to && rec.to !== to) continue;
    if (by && rec.by !== by) continue;
    out.push(rec);
  }
  return out.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/** For an agent's Brief: its open person handoffs, with progress like "3/7". */
export async function blockersFrom(store, agentRefValue) {
  return (await listBlockers(store, { by: agentRefValue })).map((r) => ({
    trail: r.trail,
    to: r.to,
    where: r.where,
    summary: r.summary,
    progress: `${(r.steps_done || []).length}/${(r.walkthrough?.steps || []).length}`,
  }));
}

function personEntry(by, kind, summary, origin, payload, now) {
  const id = by.replace(/^human:/, "");
  return { ts: now(), kind, by, via: "web", byline: `${id} (via web)`, trail: `${kind}Blocker-${now()}`, origin, summary, payload };
}

function whereOf(rec) {
  const [ns, ...rest] = String(rec.where || "").split(":");
  return { ns, id: rest.join(":") };
}

/** A person ticks (or unticks) one step. Writes one entry by that person on the work's log. */
export async function setStep(store, trail, { step, checked, by, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new BlockerError("only a person can tick a step");
  const rec = await getBlocker(store, trail);
  if (!rec) throw new BlockerError("no such blocker");
  if (rec.done) throw new BlockerError("this blocker is already done");
  const steps = rec.walkthrough?.steps || [];
  if (!Number.isInteger(step) || step < 0 || step >= steps.length) throw new BlockerError("no such step");
  const set = new Set(rec.steps_done || []);
  if (checked) set.add(step);
  else set.delete(step);
  const next = { ...rec, steps_done: [...set].sort((a, b) => a - b), updated_at: now() };
  await store.redis("SET", K.rec(store.space, trail), JSON.stringify(next));
  const { ns, id } = whereOf(rec);
  const summary = `${checked ? "Done" : "Undone"} step ${step + 1} of ${steps.length}: ${steps[step].title}`.slice(0, 1000);
  await store.append(ns, id, personEntry(by, "progress", summary, trail, { blocker: trail, step, checked: !!checked }, now));
  return next;
}

/** A person marks the blocker done. Writes a Done entry by that person and closes it. */
export async function markDone(store, trail, { by, note, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new BlockerError("only a person can mark a blocker done");
  const rec = await getBlocker(store, trail);
  if (!rec) throw new BlockerError("no such blocker");
  if (rec.done) return rec;
  const next = { ...rec, done: true, done_at: now(), done_by: by, ...(note ? { note: String(note).slice(0, 1000) } : {}) };
  await store.redis("SET", K.rec(store.space, trail), JSON.stringify(next));
  await store.redis("SREM", K.open(store.space), trail);
  const { ns, id } = whereOf(rec);
  await store.append(ns, id, personEntry(by, "done", `Done: ${rec.summary}`.slice(0, 1000), trail, { blocker: trail, ...(note ? { note: next.note } : {}) }, now));
  await linkClose(store, jobOf(rec.where), { ref: trail, outcome: "done", now });
  return next;
}

/** A person says they can't do the task, with a reason. Closes it and tells the agent on the job's log. */
export async function cantDo(store, trail, { by, reason, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new BlockerError("only a person can say a task can't be done");
  if (typeof reason !== "string" || !reason.trim()) throw new BlockerError("say why it can't be done, in one line");
  const rec = await getBlocker(store, trail);
  if (!rec) throw new BlockerError("no such blocker");
  if (rec.done) throw new BlockerError("this task is already closed");
  const why = reason.trim().slice(0, 1000);
  const next = { ...rec, done: true, done_at: now(), done_by: by, outcome: "cant_do", reason: why };
  await store.redis("SET", K.rec(store.space, trail), JSON.stringify(next));
  await store.redis("SREM", K.open(store.space), trail);
  const { ns, id } = whereOf(rec);
  await store.append(ns, id, personEntry(by, "feedback", `Can't do: ${why}`.slice(0, 1000), trail, { task: trail, cant_do: true, reason: why }, now));
  await linkClose(store, jobOf(rec.where), { ref: trail, outcome: "cant_do", now });
  return next;
}
