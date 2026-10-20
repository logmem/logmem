// work.mjs — what a signed-in person does from the web app besides deciding:
// nudge an agent about a job, and unblock a job that waits on something
// outside the team. Spec: docs/superpowers/specs/2026-10-19-logmem-live-app-design.md.
//
// Every write is an entry by that person on the job's log (and, for a nudge,
// on the agent's log), through the mirrored web store.

import { makeTrail } from "../core/tools.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";
import { lmKey } from "../core/keys.mjs";

// Unblock as one conditional transition (codex re-reviews of PR 85 and 86). In one atomic step it
// checks that the job is still blocked and that stage_at, blocked_on and waits are exactly what
// was read (a timestamp alone can repeat within a millisecond), with no open task or decision and
// no agent wait. Then it sets the job active and records the operation in a pending-audit set.
// Nothing is restored afterwards, so a newer change is never overwritten.
export const UNBLOCK_LUA = `
local function norm(v) if v == false or v == nil or v == 'null' then return '' end return v end
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= '"blocked"' then return 'not_blocked' end
if norm(redis.call('HGET', KEYS[1], 'stage_at')) ~= ARGV[1] then return 'changed' end
local bo = norm(redis.call('HGET', KEYS[1], 'blocked_on'))
if bo ~= ARGV[2] then return 'changed' end
local waits = norm(redis.call('HGET', KEYS[1], 'waits'))
if waits ~= ARGV[3] then return 'changed' end
if string.find(waits, '"type":"decision"', 1, true) or string.find(waits, '"type":"task"', 1, true) then return 'waits' end
if string.find(bo, '"type":"decision"', 1, true) or string.find(bo, '"type":"task"', 1, true) or string.find(bo, '"type":"agent"', 1, true) then return 'type' end
redis.call('HSET', KEYS[1], 'stage', '"active"', 'stage_at', ARGV[4], 'blocked_on', 'null', 'unblock_op', ARGV[5])
redis.call('SADD', KEYS[2], ARGV[5])
return 'ok'
`;
registerEvalScript(UNBLOCK_LUA, (call, keys, argv) => {
  const norm = (v) => (v == null || v === false || v === "null" ? "" : v);
  const has = (v, x) => String(v).includes(x);
  if (call("HGET", keys[0], "stage") !== '"blocked"') return "not_blocked";
  if (norm(call("HGET", keys[0], "stage_at")) !== argv[0]) return "changed";
  const bo = norm(call("HGET", keys[0], "blocked_on"));
  if (bo !== argv[1]) return "changed";
  const waits = norm(call("HGET", keys[0], "waits"));
  if (waits !== argv[2]) return "changed";
  if (has(waits, '"type":"decision"') || has(waits, '"type":"task"')) return "waits";
  if (has(bo, '"type":"decision"') || has(bo, '"type":"task"') || has(bo, '"type":"agent"')) return "type";
  call("HSET", keys[0], "stage", '"active"', "stage_at", argv[3], "blocked_on", "null", "unblock_op", argv[4]);
  call("SADD", keys[1], argv[4]);
  return "ok";
});
const pendingKey = (space, job) => `lm:${space}:job:${job}:unblock_pending`;
const opTrail = (op) => `unblockedBy-${op.id}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 200);
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
  await jobOrThrow(store, job);
  // Finish any audit an earlier Unblock left incomplete, whatever its age or the job's state now.
  const finished = await flushPending(store, job);
  const j = await jobOrThrow(store, job);
  if (j.now.stage !== "blocked") {
    // A retry after a success (lost response or a failed side effect) gets the same answer, not a 409.
    const op = j.now.unblock_op;
    const done = op && op.by === by && op.note === text ? finished.get(op.id) || (await store.readLog("job", job, { sinceMs: op.at, limit: 200 })).find((e) => e.trail === opTrail(op)) : null;
    if (done) return { ok: true, job, now: j.now, entry: done, replayed: true };
    throw new WorkError(409, "this job is not blocked");
  }
  const waiting = (Array.isArray(j.now.waits) ? j.now.waits : []).filter((w) => w.type === "decision" || w.type === "task");
  if (waiting.length) throw new WorkError(409, `this job waits on ${waiting.length === 1 ? `a ${waiting[0].type}` : `${waiting.length} open tasks or decisions`}: answer ${waiting.length === 1 ? "it" : "them"}, and the job unblocks`);
  const type = j.now.blocked_on?.type || null;
  if (type === "decision" || type === "task") throw new WorkError(409, `this job waits on a ${type}: answer it, and the job unblocks`);
  if (type === "agent") throw new WorkError(409, "this job waits on an agent: nudge it instead");
  // Compare against the raw stored fields: exactly what was read, not just a timestamp.
  const key = lmKey(store.space, "job", job, "now");
  const raw = async (f) => { const v = await store.redis("HGET", key, f); return v == null || v === "null" ? "" : String(v); };
  const [rawAt, rawOn, rawWaits] = [await raw("stage_at"), await raw("blocked_on"), await raw("waits")];
  const t = now();
  const op = { id: `unblock-${job}-${t}-${Math.random().toString(36).slice(2, 10)}`, job, by, note: text, at: t, was: j.now.blocked_on || null };
  const res = await store.redis("EVAL", UNBLOCK_LUA, 2, key, pendingKey(store.space, job), rawAt, rawOn, rawWaits, JSON.stringify(t), JSON.stringify(op));
  if (res === "changed" || res === "not_blocked") throw new WorkError(409, "this job changed while you were unblocking it. Reload and check what it waits on now");
  if (res === "waits" || res === "type") throw new WorkError(409, "this job now waits on a task, a decision or an agent: answer or nudge it instead");
  const entry = (await flushPending(store, job)).get(op.id);
  return { ok: true, job, now: await store.getNow("job", job), entry };
}

/**
 * Complete every pending Unblock audit for a job: write the person's entry once under the
 * operation's fixed trail, refresh the index, counter and mirror from the job's current state,
 * then drop the pending record. Each record stays until its own entry is written.
 */
async function flushPending(store, job) {
  const out = new Map();
  const key = pendingKey(store.space, job);
  for (const rawOp of (await store.redis("SMEMBERS", key)) || []) {
    let op;
    try {
      op = JSON.parse(rawOp);
    } catch {
      continue;
    }
    const trail = opTrail(op);
    const have = (await store.readLog("job", job, { sinceMs: op.at, untilMs: op.at, limit: 50 })).find((e) => e.trail === trail);
    const entry = have || { ts: op.at, kind: "progress", by: op.by, via: "web", byline: `${String(op.by).replace(/^human:/, "")} (via web)`, trail, summary: `Unblocked by ${String(op.by).replace(/^human:/, "")}: ${op.note}`.slice(0, 1000), job: `job:${job}`, payload: { unblocked: true, was: op.was, note: op.note, op: op.id } };
    if (!have) await store.append("job", job, entry);
    const cur = await store.getNow("job", job);
    // Mirror what the job holds now; it may be newer than this unblock (done, or blocked again).
    await store.touchNow("job", job, { stage: cur.stage ?? null, stage_at: cur.stage_at ?? null, blocked_on: cur.blocked_on ?? null });
    await store.redis("SREM", key, rawOp);
    out.set(op.id, entry);
  }
  return out;
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
