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
import { linkOpen, linkClose, jobOf } from "./links.mjs";

export const PERSON_RE = /^human:[a-z0-9][a-z0-9_.-]{0,63}$/;
export const WALKTHROUGH_LIMITS = { steps: 20, title: 120, detail: 1000, cmd: 500, field: 300 };
/** A walkthrough a person writes in the web app is shorter: at most 7 steps (walkthrough spec). */
export const WRITER_STEPS = 7;
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
      // title: what to do. go: where to go. see: what the person should see when it worked.
      return {
        title,
        ...(s.go ? { go: str(s.go, L.field, `step ${i + 1} go`) } : {}),
        ...(s.detail ? { detail: str(s.detail, L.detail, `step ${i + 1} detail`) } : {}),
        ...(s.cmd ? { cmd: str(s.cmd, L.cmd, `step ${i + 1} cmd`) } : {}),
        ...(s.see ? { see: str(s.see, L.field, `step ${i + 1} see`) } : {}),
      };
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
  // The handoff entry is written first; bump again so a pulse between the two still shows the task.
  await store.bumpRev?.();
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

// ─── the walkthrough writer (web app) ───────────────────────────────
// Spec: docs/superpowers/specs/2026-10-20-logmem-walkthrough-design.md.
// A signed-in person writes a walkthrough on a job page. It becomes a task for a
// person on that job, like an agent's handoff to "human:<id>". It can be edited
// until the first step is ticked; after that the record is what the person follows.

// Secret-shaped values never go in a walkthrough: name the vault entry instead.
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bnpm_[A-Za-z0-9]{20,}/,
  // NAME=value or NAME: value, also inside names like npm_token= or DB_PASSWORD:
  /(?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*['"]?[^\s'"]{8,}/i,
];
// A long opaque blob with letters and digits mixed (40+ characters) is treated as a value too.
const OPAQUE_RE = /[A-Za-z0-9_+/=-]{40,}/g;
const looksSecret = (text) => {
  if (SECRET_RES.some((re) => re.test(text))) return true;
  return (text.match(OPAQUE_RE) || []).some((t) => /[A-Za-z]/.test(t) && /\d/.test(t) && !/^[0-9a-f]+$/i.test(t));
};
function refuseSecrets(w, summary) {
  const texts = [summary, w.time, w.place, w.done_when, w.reply, w.due, ...w.steps.flatMap((s) => [s.title, s.go, s.detail, s.cmd, s.see])];
  if (texts.some((t) => typeof t === "string" && looksSecret(t))) {
    throw new BlockerError("this looks like a secret value. Name where it lives (for example 'the Infisical entry for the npm token') instead of pasting it");
  }
}
export const JOB_ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;

/**
 * Save a walkthrough a person wrote on a job page. New: a task for `to` on job:<job>,
 * with a handoff entry by the writer and the job linked to it (waits). With `trail`:
 * replace the walkthrough while nobody has ticked a step yet.
 */
export async function writeWalkthrough(store, { job, to, summary, walkthrough, trail, by, now = Date.now, mint }) {
  if (!PERSON_RE.test(String(by))) throw new BlockerError("only a signed-in person writes a walkthrough here");
  if (!PERSON_RE.test(String(to))) throw new BlockerError("who it is for must be a person, 'human:<id>'");
  if (typeof summary !== "string" || !summary.trim()) throw new BlockerError("give the walkthrough a title");
  const title = summary.trim();
  if (title.length > WALKTHROUGH_LIMITS.title) throw new BlockerError(`the title is longer than ${WALKTHROUGH_LIMITS.title} characters`);
  const w = normalizeWalkthrough(walkthrough || {});
  if (!w || !w.steps.length) throw new BlockerError("a walkthrough needs at least one step");
  if (w.steps.length > WRITER_STEPS) throw new BlockerError(`a walkthrough written here has at most ${WRITER_STEPS} steps`);
  refuseSecrets(w, title);

  if (trail) {
    const rec = await getBlocker(store, String(trail));
    if (!rec) throw new BlockerError("no such walkthrough");
    if (rec.done) throw new BlockerError("this walkthrough is already closed");
    if ((rec.steps_done || []).length) throw new BlockerError("someone has started this walkthrough, so it can't change now. Write a new one");
    if (rec.by !== by) throw new BlockerError("only the person who wrote this walkthrough can edit it");
    const next = { ...rec, to, summary: title, walkthrough: w, updated_at: now() };
    await store.redis("SET", K.rec(store.space, rec.trail), JSON.stringify(next));
    const { ns, id } = whereOf(rec);
    await store.append(ns, id, personEntry(by, "progress", `Walkthrough edited: ${title}`.slice(0, 1000), rec.trail, { blocker: rec.trail, steps: w.steps.length }, now));
    return next;
  }

  if (!JOB_ID_RE.test(String(job || ""))) throw new BlockerError("job is not valid");
  if (!(await store.getWho("job", job))) throw new BlockerError(`job '${job}' does not exist`);
  const t = now();
  const tr = mint ? mint(job, t) : `walkthrough-${job}-${t}`;
  if (!TRAIL_RE.test(tr)) throw new BlockerError("trail is not valid");
  const who = by.replace(/^human:/, "");
  await store.append("job", job, {
    ts: t, kind: "handoff", by, via: "web", byline: `${who} (via web)`, trail: tr, summary: title,
    to, job: `job:${job}`, payload: { walkthrough: w, written_in: "web" },
  });
  await createBlocker(store, { trail: tr, to, by, where: `job:${job}`, summary: title, walkthrough: w, created_at: t });
  await linkOpen(store, job, { type: "task", ref: tr, note: title, now: () => t });
  return getBlocker(store, tr);
}
