// work.mjs — what a signed-in person does from the web app besides deciding:
// nudge an agent about a job, and unblock a job that waits on something
// outside the team. Spec: docs/superpowers/specs/2026-10-19-logmem-live-app-design.md.
//
// Every write is an entry by that person on the job's log (and, for a nudge,
// on the agent's log), through the mirrored web store.

import { makeTrail } from "../core/tools.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";
import { lmKey } from "../core/keys.mjs";

// Unblock as one conditional transition (codex re-review of PR 85). In one atomic step it checks
// that the job is still blocked, unchanged since it was read (stage_at), has no open task or
// decision, and does not wait on an agent. Then it sets the job active and records the operation.
// Nothing is restored afterwards, so a newer change is never overwritten.
export const UNBLOCK_LUA = `
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= '"blocked"' then return 'not_blocked' end
local sa = redis.call('HGET', KEYS[1], 'stage_at') or ''
if sa == 'null' then sa = '' end
if sa ~= ARGV[1] then return 'changed' end
local waits = redis.call('HGET', KEYS[1], 'waits') or ''
if string.find(waits, '"type":"decision"', 1, true) or string.find(waits, '"type":"task"', 1, true) then return 'waits' end
local bo = redis.call('HGET', KEYS[1], 'blocked_on') or ''
if string.find(bo, '"type":"decision"', 1, true) or string.find(bo, '"type":"task"', 1, true) or string.find(bo, '"type":"agent"', 1, true) then return 'type' end
redis.call('HSET', KEYS[1], 'stage', '"active"', 'stage_at', ARGV[2], 'blocked_on', 'null', 'unblock_op', ARGV[3])
return 'ok'
`;
registerEvalScript(UNBLOCK_LUA, (call, keys, argv) => {
  const has = (v, s) => String(v ?? "").includes(s);
  if (call("HGET", keys[0], "stage") !== '"blocked"') return "not_blocked";
  const sa = call("HGET", keys[0], "stage_at") ?? "";
  if ((sa === "null" ? "" : sa) !== argv[0]) return "changed";
  const waits = call("HGET", keys[0], "waits");
  if (has(waits, '"type":"decision"') || has(waits, '"type":"task"')) return "waits";
  const bo = call("HGET", keys[0], "blocked_on");
  if (has(bo, '"type":"decision"') || has(bo, '"type":"task"') || has(bo, '"type":"agent"')) return "type";
  call("HSET", keys[0], "stage", '"active"', "stage_at", argv[1], "blocked_on", "null", "unblock_op", argv[2]);
  return "ok";
});
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
  const key = lmKey(store.space, "job", job, "now");
  if (j.now.stage !== "blocked") return finishUnblock(store, { job, j, by, text, now });
  const waiting = (Array.isArray(j.now.waits) ? j.now.waits : []).filter((w) => w.type === "decision" || w.type === "task");
  if (waiting.length) throw new WorkError(409, `this job waits on ${waiting.length === 1 ? `a ${waiting[0].type}` : `${waiting.length} open tasks or decisions`}: answer ${waiting.length === 1 ? "it" : "them"}, and the job unblocks`);
  const type = j.now.blocked_on?.type || null;
  if (type === "decision" || type === "task") throw new WorkError(409, `this job waits on a ${type}: answer it, and the job unblocks`);
  if (type === "agent") throw new WorkError(409, "this job waits on an agent: nudge it instead");
  const t = now();
  // The operation id is fixed by what was unblocked, so a retry of this unblock reuses it.
  const op = { id: `unblock-${job}-${j.now.stage_at ?? "0"}`, by, note: text, at: t, was: j.now.blocked_on || null };
  const res = await store.redis("EVAL", UNBLOCK_LUA, 1, key, j.now.stage_at == null ? "" : JSON.stringify(j.now.stage_at), JSON.stringify(t), JSON.stringify(op));
  if (res === "changed") throw new WorkError(409, "this job changed while you were unblocking it. Reload and check what it waits on now");
  if (res === "waits" || res === "type") throw new WorkError(409, "this job now waits on a task, a decision or an agent: answer or nudge it instead");
  if (res !== "ok") return finishUnblock(store, { job, j: await jobOrThrow(store, job), by, text, now });
  return finishUnblock(store, { job, j: { who: j.who, now: { ...j.now, stage: "active", stage_at: t, blocked_on: null, unblock_op: op } }, by, text, now, fresh: true });
}

/**
 * The parts of an unblock after its atomic transition: the index, counter and mirror, then the
 * person's entry under the operation's fixed trail. Run again on a retry, it finishes whatever a
 * failure left out and writes the entry once.
 */
async function finishUnblock(store, { job, j, by, text, now, fresh = false }) {
  const op = j.now.unblock_op;
  const mine = op && op.by === by && op.note === text && now() - Number(op.at) < 10 * 60e3 && j.now.stage !== "blocked";
  if (!mine) throw new WorkError(409, "this job is not blocked");
  const trail = `unblockedBy-${op.id}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 200);
  // Mirror what the job holds now: on a retry that may be newer than the unblock (done, or blocked again).
  await store.touchNow("job", job, { stage: j.now.stage, stage_at: j.now.stage_at ?? null, blocked_on: j.now.blocked_on ?? null, unblock_op: op });
  const have = (await store.readLog("job", job, { sinceMs: op.at, limit: 50 })).find((e) => e.trail === trail);
  const entry = have || { ts: op.at, kind: "progress", by, via: "web", byline: `${by.replace(/^human:/, "")} (via web)`, trail, summary: `Unblocked by ${by.replace(/^human:/, "")}: ${text}`.slice(0, 1000), job: `job:${job}`, payload: { unblocked: true, was: op.was, note: text, op: op.id } };
  if (!have) await store.append("job", job, entry);
  return { ok: true, job, now: await store.getNow("job", job), entry, ...(fresh ? {} : { replayed: true }) };
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
