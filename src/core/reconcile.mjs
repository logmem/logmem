// reconcile.mjs — close jobs whose work is already done, with evidence (job auto-close-reconciler).
//
// Spec: docs/superpowers/specs/2026-10-21-logmem-auto-close-design.md.
//
// A job only changes stage when someone calls logmem_stage, so finished work
// often leaves its job "active" and the board stops being a source of truth.
// planCloses() looks at every open, active or blocked job for hard evidence:
//
//   pr         a merged PR whose body says "Closes job: <id>", with no entry on
//              the job more than an hour after the merge.
//   parts      a milestone whose child jobs are all done (at least one), or a
//              job blocked only on a person's task that is now done.
//
// An owner's Done entry is only a suggestion: the first dry run on madez showed
// agents write "done" for one finished step, not the whole job.
//
// Suggestions only (never a close): a PR in the job's evidence field (the first
// dry run found one that was where the job started), a closing PR with work
// after the merge, an owner's Done entry, and a plain "Job: <id>" mention.
//
// It skips jobs that are parked, that a person reopened (Now auto_close: "off"),
// or that have a reopen ask waiting. A plain "Job: <id>" mention in a merged PR
// is only a suggestion, never a close: one PR often fixes part of a job.
// Overdue jobs with no entry for 48 hours are reported as stale.
//
// applyPlan() closes as agent:logmem-reconciler: a Done entry citing the
// evidence, Now auto_closed { at, prev_stage, signal, evidence }, and a
// handoff to the owner to acknowledge or ask to reopen. A reopen needs a
// person: the owner asks "Reopen <job>?" on the job, and once a person
// approves, the next run restores the old stage and turns auto-close off for
// that job. Agents can never reopen on their own.

import { randomUUID } from "node:crypto";
import { stableJson } from "./store.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";

export const RECONCILER = "logmem-reconciler";

// Record the Done entry and its durable receipt together. A lost response can
// retry without another log member, including when two workers repair at once.
const AUDIT_LUA = `-- reconcile audit append
if redis.call('HGET', KEYS[1], 'auto_closed') ~= ARGV[1] then return 'changed' end
local n = #redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[2], ARGV[2])
local member = '{"_o":"' .. string.format('%06d', n) .. '",' .. string.sub(ARGV[3], 2)
redis.call('ZADD', KEYS[2], ARGV[2], member)
redis.call('HSET', KEYS[1], 'auto_closed', ARGV[4])
return 'ok'
`;
registerEvalScript(AUDIT_LUA, (call, keys, argv) => {
  if (call("HGET", keys[0], "auto_closed") !== argv[0]) return "changed";
  const n = call("ZRANGEBYSCORE", keys[1], argv[1], argv[1]).length;
  call("ZADD", keys[1], argv[1], `{"_o":"${String(n).padStart(6, "0")}",${argv[2].slice(1)}`);
  call("HSET", keys[0], "auto_closed", argv[3]);
  return "ok";
});
export const STALE_MS = 48 * 3600 * 1000;
/** Entries more than an hour after a merge mean the work went on: the PR only suggests. */
export const LATER_MS = 3600 * 1000;
const OPEN_STAGES = new Set(["open", "active", "blocked"]);
const JOB_ID = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const CLOSES_RE = new RegExp(String.raw`\bCloses job:\s*\x60?(${JOB_ID})\x60?`, "gi");
const MENTION_RE = new RegExp(String.raw`\bJob:\s*\x60?(${JOB_ID})\x60?`, "g");
const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
export const REOPEN_RE = /^\s*Reopen\b/i;
/** The last report, for the app's Needs you and the board's stale badge. */
export const reportKey = (space) => `lm:${space}:reconcile:report`;

/**
 * Now fields a close must find unchanged when it applies (codex on PR 106):
 * a blocker, a reopen or a "still open" that lands after the plan wins.
 */
export const GUARD_FIELDS = ["stage", "blocked_on", "waits", "auto_close", "auto_closed", "reconcile_dismissed"];

const agentOf = (ref) => String(ref || "").replace(/^agent:/, "");
const isAgentRef = (ref) => /^agent:/.test(String(ref || ""));

/** Job ids a merged PR closes, and ids it only mentions. */
export function jobsInBody(body) {
  const text = String(body || "");
  const closes = new Set([...text.matchAll(CLOSES_RE)].map((m) => m[1]));
  const mentions = new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]).filter((id) => !closes.has(id)));
  return { closes: [...closes], mentions: [...mentions] };
}

/** PR numbers named in a job's evidence field, for one repo. */
export function evidencePRs(evidence, repo) {
  const out = [];
  for (const m of String(evidence || "").matchAll(PR_URL_RE)) if (m[1].toLowerCase() === String(repo).toLowerCase()) out.push(Number(m[2]));
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "2026-10-24", or "Oct 16" (this year), to the end of that UTC day in ms; anything else is null. */
export function dueMs(due, now = Date.now()) {
  const s = String(due || "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 23, 59, 59);
  const md = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/.exec(s.trim());
  const mi = md ? MONTHS.indexOf(md[1].toLowerCase()) : -1;
  if (mi < 0) return null;
  return Date.UTC(new Date(now).getUTCFullYear(), mi, Number(md[2]), 23, 59, 59);
}

/**
 * Plan for one space. Reads only.
 *   github: { repo, merged() -> [{ number, merged_at, merge_commit_sha, body, html_url }] } or null.
 * Returns { closes, reopens, suggestions, stale, skipped, github }.
 */
export async function planCloses(store, { now = Date.now(), github = null, blockerOf = null, briefOf = null } = {}) {
  const briefs = new Map();
  const brief = async (agent) => {
    if (!briefOf || !agent) return null;
    if (!briefs.has(agent)) briefs.set(agent, await briefOf(agent).catch(() => null));
    return briefs.get(agent);
  };
  const ids = await store.list("job");
  const jobs = new Map();
  const unreadable = [];
  // One job the backend can't read is skipped; the run goes on.
  for (const id of ids) {
    try {
      // The guard is read before Now, so any write after it fails the close's compare-and-set.
      const guard = await store.nowFieldsRaw("job", id, GUARD_FIELDS);
      jobs.set(id, { id, guard, who: (await store.getWho("job", id)) || {}, now: (await store.getNow("job", id)) || {} });
    } catch {
      unreadable.push(id);
    }
  }

  // GitHub: merged PRs by the jobs they close or mention. Unreachable = no PR signal at all.
  let ghState = "off";
  const closedBy = new Map(), mentionedBy = new Map(), byNumber = new Map();
  if (github) {
    try {
      for (const pr of await github.merged()) {
        if (!pr?.merged_at) continue;
        byNumber.set(Number(pr.number), pr);
        const { closes, mentions } = jobsInBody(pr.body);
        for (const id of closes) if (!closedBy.has(id)) closedBy.set(id, pr);
        for (const id of mentions) if (!mentionedBy.has(id)) mentionedBy.set(id, pr);
      }
      ghState = "ok";
    } catch {
      ghState = "unreachable";
    }
  }

  const children = new Map();
  for (const j of jobs.values()) {
    const parent = typeof j.who.milestone === "string" ? j.who.milestone : null;
    if (parent) (children.get(parent) || children.set(parent, []).get(parent)).push(j);
  }

  const plan = { closes: [], repairs: [], reopens: [], suggestions: [], stale: [], skipped: unreadable.map((job) => ({ job, why: "unreadable" })), github: ghState };
  for (const j of jobs.values()) {
    const stage = j.now.stage || "open";
    // A closed stage is not proof that its audit and owner notification landed.
    if (j.now.auto_closed?.audit_pending) {
      plan.repairs.push({ job: j.id });
      continue;
    }
    let log;
    try {
      log = await store.readLog("job", j.id, { reverse: true, limit: 50 });
    } catch {
      plan.skipped.push({ job: j.id, why: "unreadable" });
      continue;
    }
    const owner = j.now.owner || j.who.owner || null;

    // A reopen of an auto-closed job that a person approved: restore the old stage (applied in applyPlan).
    const reopen = j.now.auto_closed ? reopenState(await brief(owner), j) : {};
    if (reopen.approved) {
      plan.reopens.push({ job: j.id, to_stage: j.now.auto_closed.prev_stage || "active", decision: reopen.approved.trail });
      continue;
    }
    if (!OPEN_STAGES.has(stage)) continue;

    // Stale: overdue, and nothing written for 48 hours.
    const due = dueMs(j.who.due, now);
    const last = log[0]?.ts ?? 0;
    if (due && due < now && now - last > STALE_MS) plan.stale.push({ job: j.id, title: j.who.title || null, due: j.who.due, last_entry_at: last || null, owner });

    if (j.now.blocked_on?.parked) { plan.skipped.push({ job: j.id, why: "parked" }); continue; }
    if (j.now.auto_close === "off") { plan.skipped.push({ job: j.id, why: "a person reopened it" }); continue; }
    if (reopen.pending) { plan.skipped.push({ job: j.id, why: "reopen ask waiting" }); continue; }

    const hit = await evidenceFor(j, { log, owner, children, closedBy, byNumber, github, blockerOf, unreadable });
    // A person said "still open": no suggestion until the job gets a newer entry.
    const dismissed = !!j.now.reconcile_dismissed && log[0]?.trail === j.now.reconcile_dismissed.trail;
    if (hit) plan.closes.push({ job: j.id, title: j.who.title || null, owner, prev_stage: stage, guard: j.guard, ...hit });
    else if (dismissed) plan.skipped.push({ job: j.id, why: "a person said it is still open" });
    else if (ownerSaysDone(log, owner)) {
      // Agents also write "done" for one finished step, so an owner's Done only suggests.
      plan.suggestions.push({ job: j.id, title: j.who.title || null, owner, signal: "owner", evidence: `Owner ${agentOf(owner)} wrote: ${String(log[0].summary).slice(0, 160)}` });
    } else if (closedBy.has(j.id)) {
      const pr = closedBy.get(j.id);
      plan.suggestions.push({ job: j.id, title: j.who.title || null, owner, signal: "pr-later", evidence: `PR #${pr.number} closes this job, but the job has entries after the merge` });
    } else if (evidenceMerged(j, github, byNumber)) {
      const n = evidenceMerged(j, github, byNumber);
      plan.suggestions.push({ job: j.id, title: j.who.title || null, owner, signal: "pr-evidence", evidence: `PR #${n} in this job's evidence merged. Evidence can be where the job started, so this only suggests` });
    } else if (mentionedBy.has(j.id)) {
      const pr = mentionedBy.get(j.id);
      plan.suggestions.push({ job: j.id, title: j.who.title || null, owner, signal: "pr-mention", evidence: `PR #${pr.number} merged and names this job, but does not say "Closes job"` });
    }
  }
  return plan;
}

async function evidenceFor(j, { log, owner, children, closedBy, byNumber, github, blockerOf, unreadable }) {
  // 1. A merged PR says it closes the job, and nobody worked on the job after the merge.
  const pr = closedBy.get(j.id);
  if (pr) {
    const merged = Date.parse(pr.merged_at) || 0;
    const later = (log[0]?.ts ?? 0) > merged + LATER_MS;
    if (!later) return { signal: "pr", evidence: `PR #${pr.number} merged as ${String(pr.merge_commit_sha || "").slice(0, 7)} and closes this job`, link: pr.html_url || null };
  }
  // 2. Its parts are done.
  // A job we could not read may belong to this milestone, so its parts are
  // unknown: no milestone closes on parts in that run (codex on PR 106).
  if (j.who.milestone === true && !unreadable.length) {
    const kids = children.get(j.id) || [];
    if (kids.length && kids.every((k) => k.now.stage === "done")) return { signal: "parts", evidence: `All ${kids.length} jobs of milestone ${j.id} are done` };
  }
  // A blocked job closes on its task only when every wait on it is a task a
  // person finished. Any other wait (a decision, an agent, an outside thing,
  // a task not done or can't-do) keeps it open (codex on PR 106).
  if (j.now.stage === "blocked" && blockerOf) {
    const waits = waitsOf(j.now);
    if (!waits.length || !waits.every((w) => w?.type === "task" && w.ref)) return null;
    const tasks = [];
    for (const w of waits) {
      const t = await blockerOf(w.ref).catch(() => null);
      if (!t?.done || t.outcome === "cant_do") return null;
      tasks.push(`${w.ref}, by ${t.done_by || "a person"}`);
    }
    const what = tasks.length === 1 ? `The task it waited on is done (${tasks[0]})` : `All ${tasks.length} tasks it waited on are done (${tasks.join("; ")})`;
    return { signal: "parts", evidence: what };
  }
  return null;
}

/** blocked_on and every entry in waits, once each by ref. */
function waitsOf(now) {
  const all = [now.blocked_on, ...(Array.isArray(now.waits) ? now.waits : [])].filter(Boolean);
  const seen = new Set();
  return all.filter((w) => {
    const key = w.ref ?? JSON.stringify(w);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The job's newest entry is a Done by its owner (not a person's task Done). A suggestion, never a close. */
function ownerSaysDone(log, owner) {
  const top = log[0];
  return !!(top && owner && top.by === owner && !top.payload?.blocker && (top.kind === "done" || (top.kind === "accepted" && /^(Accepted: )?Done:/.test(String(top.summary || "")))));
}

/**
 * A reopen ask by the owner on this job, since the auto-close: pending, or
 * approved. Read from the owner's Brief, so only verified decisions count.
 */
/** The first merged PR in the job's evidence field, or 0. */
function evidenceMerged(j, github, byNumber) {
  if (!github?.repo) return 0;
  return evidencePRs(j.who.evidence, github.repo).find((n) => byNumber.has(n)) || 0;
}

export function reopenState(b, j) {
  if (!b) return {};
  const since = j.now.auto_closed?.at ?? 0;
  const mine = (x) => x.where === `job:${j.id}` && REOPEN_RE.test(String(x.question || "")) && (x.asked_at ?? 0) >= since;
  const approved = (b.answered_asks || []).find((x) => mine(x) && x.verdict === "approve");
  if (approved) return { approved };
  const pending = (b.pending_asks || []).find(mine);
  return pending ? { pending } : {};
}

/**
 * Apply a plan as agent:logmem-reconciler. `lm` is a LogMem instance locked
 * to RECONCILER; `store` is its store. Returns what changed.
 */
export async function applyPlan(lm, store, plan, { now = Date.now() } = {}) {
  const call = async (name, args) => (await lm.callTool(name, args)).structuredContent;
  const done = [], reopened = [], failed = [];
  const finishAudit = async (job) => {
    let guard = await store.nowFieldsRaw("job", job, ["auto_closed"]);
    let closed = JSON.parse(guard.auto_closed || "null");
    if (!closed?.audit_pending) return false;
    if (!closed.audit_written) {
      const written = { ...closed, audit_written: true };
      const result = await store.redis("EVAL", AUDIT_LUA, 2, store.key("job", job, "now"), store.key("job", job, "log"),
        guard.auto_closed, String(closed.audit_entry.ts), stableJson(closed.audit_entry), JSON.stringify(written));
      if (result !== "ok") throw new Error("audit changed during repair; retry next run");
      closed = written;
      guard = { auto_closed: JSON.stringify(written) };
    }
    await store.repairEntry("job", job, closed.audit_entry);
    if (isAgentRef(closed.owner) && agentOf(closed.owner) !== RECONCILER) {
      const recipient = agentOf(closed.owner);
      const prior = await store.readLog("agent", recipient, { reverse: true });
      if (!prior.some((e) => e.kind === "handoff" && e.trail === closed.ack_trail && e.to === closed.owner)) {
        const r = await call("logmem_handoff", {
          to: recipient, where: `job:${job}`, trail: closed.ack_trail, create_agent: true,
          summary: `Auto-closed job ${job}: ${closed.evidence}. Accept to acknowledge. If the work is not finished, call logmem_ask on job:${job} with a question that starts "Reopen ${job}?" and your reason. A person approves it, then LogMem restores the old stage.`.slice(0, 1000),
        });
        if (!r?.ok) throw new Error(r?.error || "owner handoff refused");
      }
    }
    if (!await store.setNowIf("job", job, guard, { auto_closed: { ...closed, audit_pending: false } })) {
      throw new Error("audit changed during completion; retry next run");
    }
    return true;
  };
  for (const c of [...(plan.repairs || []), ...plan.closes]) {
    try {
      if (!c.guard) {
        if ((plan.repairs || []).some((r) => r.job === c.job)) {
          if (await finishAudit(c.job)) done.push(c.job);
          continue;
        }
        throw new Error("no guard in the plan");
      }
      // One compare-and-set: the close lands only if the job's Now is still what the plan read.
      const operation = randomUUID();
      const auto_closed = {
        at: now, prev_stage: c.prev_stage, signal: c.signal, evidence: c.evidence,
        audit_pending: true, owner: c.owner, ack_trail: `reconcileAck-${operation}`,
        audit_entry: { ts: now, kind: "done", by: `agent:${RECONCILER}`, via: "reconciler",
          trail: `reconcileDone-${operation}`, summary: `auto-closed. ${c.evidence}`.slice(0, 1000) },
      };
      const wrote = await store.setNowIf("job", c.job, c.guard, { stage: "done", stage_at: now, blocked_on: null, auto_closed });
      if (!wrote) {
        failed.push({ job: c.job, error: "changed since the plan, not closed" });
        continue;
      }
      if (await finishAudit(c.job)) done.push(c.job);
    } catch (e) {
      failed.push({ job: c.job, error: String(e?.message || e).slice(0, 200) });
    }
  }
  for (const r of plan.reopens) {
    try {
      const out = await call("logmem_stage", { job: r.job, stage: r.to_stage === "blocked" ? "active" : r.to_stage, note: `reopened: a person approved the reopen ask (${r.decision}). Auto-close is off for this job.` });
      if (!out?.ok) throw new Error(out?.error || "stage refused");
      await store.setNow("job", r.job, { auto_close: "off", auto_closed: null });
      reopened.push(r.job);
    } catch (e) {
      failed.push({ job: r.job, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { closed: done, reopened, failed };
}

/** GitHub merged PRs for one repo (newest 100 closed). Throws when GitHub can't be read. */
export function githubSource({ repo, token, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!repo || typeof fetchImpl !== "function") return null;
  return {
    repo,
    async merged() {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "logmem-reconciler", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`github ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error("github: bad reply");
      return list.filter((p) => p && p.merged_at).map((p) => ({ number: p.number, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha, body: p.body || "", html_url: p.html_url }));
    },
  };
}
