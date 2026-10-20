// work.mjs — what a signed-in person does from the web app besides deciding:
// nudge an agent about a job, and unblock a job that waits on something
// outside the team. Spec: docs/superpowers/specs/2026-10-19-logmem-live-app-design.md.
//
// Every write is an entry by that person on the job's log (and, for a nudge,
// on the agent's log), through the mirrored web store.

import { makeTrail } from "../core/tools.mjs";
import { setLane, laneText, PlanError } from "../core/plans.mjs";
import { checkAgentId } from "../core/keys.mjs";

export class WorkError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "WorkError";
    this.status = status;
  }
}

const PERSON_RE = /^human:[a-z0-9][a-z0-9_.-]{0,63}$/;
const JOB_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function personEntry(by, kind, summary, extra, payload, now) {
  const t = now();
  const id = by.replace(/^human:/, "");
  return { ts: t, kind, by, via: "web", byline: `${id} (via web)`, trail: makeTrail(kind, extra.job || id, t), summary: String(summary).slice(0, 1000), ...extra, ...(payload ? { payload } : {}) };
}

async function jobOrThrow(store, job) {
  if (!JOB_RE.test(String(job || ""))) throw new WorkError(400, "job must be a job id");
  const who = await store.getWho("job", job);
  if (!who) throw new WorkError(404, `no job '${job}' in this space`);
  return { who, now: (await store.getNow("job", job)) || {} };
}

const cleanNote = (note) => {
  if (note == null || note === "") return undefined;
  if (typeof note !== "string") throw new WorkError(400, "note must be text");
  return note.trim().slice(0, 300) || undefined;
};

/** A ping from a person to an agent about a job. The agent defaults to the job owner. */
export async function nudge(store, { job, agent, note, by, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new WorkError(403, "only a person can nudge");
  const j = await jobOrThrow(store, job);
  const owner = String(j.now.owner || j.who.owner || "").replace(/^agent:/, "");
  let to;
  try {
    to = checkAgentId(agent || owner, "agent");
  } catch {
    throw new WorkError(400, agent ? "agent must be an agent id" : "this job has no owner; name the agent to nudge");
  }
  const text = cleanNote(note);
  const name = by.replace(/^human:/, "");
  const reason = j.now.stage === "blocked" && !j.now.blocked_on ? " It is blocked with no reason: say what it waits on." : "";
  const summary = `Nudge from ${name} on ${j.who.title || job}: ${text || "Can you move this job?"}${reason}`;
  const entry = personEntry(by, "ping", summary, { job: `job:${job}`, to: `agent:${to}` }, { nudge: true, ...(text ? { note: text } : {}) }, now);
  await store.append("job", job, entry);
  await store.append("agent", to, entry);
  return { ok: true, job, to, entry };
}

/**
 * A person unblocks a job that waits on something outside the team, or on
 * nothing named. A job blocked on a decision or a task clears when that is
 * answered; one blocked on an agent gets a nudge instead.
 */
export async function unblock(store, { job, note, by, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new WorkError(403, "only a person can unblock");
  const text = cleanNote(note);
  if (!text) throw new WorkError(400, "say in one line why the job can move again");
  const j = await jobOrThrow(store, job);
  if (j.now.stage !== "blocked") throw new WorkError(409, "this job is not blocked");
  const type = j.now.blocked_on?.type || null;
  if (type === "decision" || type === "task") throw new WorkError(409, `this job waits on a ${type}: answer it, and the job unblocks`);
  if (type === "agent") throw new WorkError(409, "this job waits on an agent: nudge it instead");
  const t = now();
  const fresh = await store.setNow("job", job, { stage: "active", stage_at: t, blocked_on: null });
  const entry = personEntry(by, "progress", `Unblocked by ${by.replace(/^human:/, "")}: ${text}`, { job: `job:${job}` }, { unblocked: true, was: j.now.blocked_on || null, note: text }, () => t);
  await store.append("job", job, entry);
  return { ok: true, job, now: fresh, entry };
}

/** A person sets a lane: make it P0, keep it active, or park it with a reason. Logged on channel:lanes. */
export async function lane(store, { plan, status, why, until, by, now = Date.now }) {
  if (!PERSON_RE.test(String(by))) throw new WorkError(403, "only a person can set a lane here");
  let out;
  try {
    out = await setLane(store, String(plan || ""), { status, why, until, by, now });
  } catch (e) {
    if (e instanceof PlanError) throw new WorkError(400, e.message);
    throw e;
  }
  const entry = personEntry(by, "memo", laneText(out.plan, out.was, out.demoted), {}, { lane: out.plan.lane, plan: out.plan.id, was: out.was, demoted: out.demoted }, now);
  await store.append("channel", "lanes", entry);
  return { ok: true, plan: out.plan, was: out.was, demoted: out.demoted, entry };
}
