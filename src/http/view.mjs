// view.mjs — read-only views of one space for the web app.
//
// Every Redis call goes through the read-only guard, so the web app cannot
// write even though the deploy holds read-write bridge creds. Views return
// plain JSON shaped for the pages; nothing secret (no tokens, no full URLs).

import { createStore } from "../core/store.mjs";
import { readOnly } from "../lib/read-only.mjs";
import { keywordRecall, askDigest, canonicalAsks, decisionsFor, askState, annotateDecisions, isDeclined, findAsk, verifyDecision } from "../core/tools.mjs";
import { listBlockers } from "../core/blockers.mjs";
import { listPlans, getPlan, getPlans } from "../core/plans.mjs";
import { lmDecisionKey } from "../core/keys.mjs";
import { buildScorecard } from "../../api/scorecard.mjs";
import { KINDS } from "../core/vocab.mjs";
import { checkAgentId } from "../core/keys.mjs";

const MAX_LOGS = 300;
const GROUP = Object.fromEntries(Object.entries(KINDS).map(([k, d]) => [k, d.group]));
export const groupOf = (kind) => GROUP[kind] || "system";

async function scanKeys(r, pattern) {
  let cursor = "0";
  const out = new Set();
  do {
    const [next, batch] = await r("SCAN", cursor, "MATCH", pattern, "COUNT", "1000");
    cursor = String(next);
    for (const k of batch) out.add(k);
  } while (cursor !== "0" && out.size < 5000);
  return [...out];
}

/** Last-seen bucket from the newest entry an agent wrote. Not presence, not health. */
export function seen(ts, now = Date.now()) {
  if (!ts) return { state: "unknown", since: "never" };
  const m = Math.round((now - ts) / 60000);
  const since = m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return { state: m <= 15 ? "active" : m <= 120 ? "idle" : "offline", since };
}

/** Digest for a view row: the one slim() computed from the raw entry, else computed now (direct callers). */
const viewDigest = (e) => e.ask_digest ?? askDigest(e);

const slim = (e, from) => ({
  ts: e.ts, kind: e.kind, group: groupOf(e.kind), by: e.by, via: e.via, summary: e.summary,
  trail: e.trail, origin: e.origin, where: from, to: e.to,
  // Asks carry the digest of their canonical content (computed here from the
  // raw entry, never read from it) so decisionsFrom can pick the canonical one.
  ...(e.kind === "approval" ? { ask_digest: askDigest(e) } : {}),
  ...(e.legacy === true ? { legacy: true } : {}),
  payload: e.kind === "approval" ? { action: e.action, reversible: e.reversible } : e.kind === "decided" ? { verdict: e.payload?.verdict ?? null, note: e.payload?.note ?? null, ask_hash: e.payload?.ask_hash ?? null, sig: e.payload?.sig ?? null } : undefined,
});

export async function allEntries(store, r, space, { limit = 200 } = {}) {
  // Job and channel logs first: an entry written to several logs (handoff,
  // ask) is shown once, where the work lives, not on each agent's log too.
  const keys = (await scanKeys(r, `lm:${space}:*:log`)).sort((a, b) => (a.includes(":agent:") ? 1 : 0) - (b.includes(":agent:") ? 1 : 0)).slice(0, MAX_LOGS);
  const merged = [];
  const seenSig = new Set();
  for (const k of keys) {
    const m = k.match(new RegExp(`^lm:${space}:([^:]+):([^:]+):log$`));
    if (!m) continue;
    for (const e of await store.readLog(m[1], m[2], { reverse: true, limit: 100 })) {
      // Asks dedupe on their content digest too, so a twin under the same
      // ts/trail/summary can never hide the canonical ask.
      const sig = `${e.ts}|${e.trail}|${e.summary}${e.kind === "approval" ? `|${askDigest(e)}` : ""}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      merged.push(slim(e, `${m[1]}:${m[2]}`));
    }
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit);
}

/** Run fn over items, n at a time: parallel enough to be fast over a REST bridge, bounded so it never floods it. */
async function inBatches(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

const jobOf = (where) => {
  const m = /^job:(.+)$/.exec(String(where || ""));
  return m ? m[1] : null;
};

/**
 * Open decisions from the ask registry (live app spec): every registered ask
 * with no settling claim, read back through findAsk so only the canonical
 * ask counts. Deferrals come from the asker's log after the ask.
 */
export async function pendingDecisions(store, r, space, { secret } = {}) {
  const prefix = `lm:${space}:ask:`;
  const trails = (await scanKeys(r, `${prefix}*`)).map((k) => k.slice(prefix.length));
  // A decision key hides an ask only when it really settles it: a signed claim that verifies with
  // today's key and binds this ask's hash. Junk, old-key and altered claims leave the ask open, as in the Brief.
  const settledBy = (raw, askHash) => {
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      return false;
    }
    const claim = rec && typeof rec === "object" ? (rec.entry && typeof rec.entry === "object" ? rec.entry : rec.kind === "decided" ? rec : null) : null;
    if (!claim || claim.kind !== "decided" || claim.payload?.ask_hash !== askHash) return false;
    try {
      return verifyDecision(claim, { secret, space }) === true;
    } catch {
      return false;
    }
  };
  const open = (await inBatches(trails, 25, async (t) => {
    try {
      const raw = await r("GET", lmDecisionKey(space, t));
      if (raw == null) return t;
      const reg = JSON.parse((await r("GET", `${prefix}${t}`)) || "null");
      return settledBy(raw, reg?.hash) ? null : t;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const rows = (await inBatches(open, 10, async (t) => {
    try {
      const f = await findAsk(store, t, { secret });
      if (!f) return [];
      const where = f.ask.where || `agent:${f.asker}`;
      const later = (await store.readLog("agent", f.asker, { sinceMs: f.ask.ts, limit: 200 })).filter((e) => e.origin === t);
      return [slim(f.ask, where), ...later.map((e) => slim(e, `agent:${f.asker}`))];
    } catch {
      return [];
    }
  })).flat();
  return decisionsFrom(rows, { secret, space, ...(await askState(store, rows)) }).waiting;
}

/** What one person needs to do: open tasks for them and open decisions, each with its job and plan. */
export async function needsView(store, r, space, { secret, person = "human:admin" } = {}) {
  const tasks = (await listBlockers(store)).filter((b) => b.to === person || person === "human:admin");
  // An ask addressed to a named person belongs in that person's inbox only (only they can answer it).
  const decisions = (await pendingDecisions(store, r, space, { secret })).filter((a) => !a.to || a.to === person);
  const jobs = new Map();
  const planOf = async (job) => {
    if (!job) return null;
    if (!jobs.has(job)) jobs.set(job, (await store.getWho("job", job))?.plan ?? null);
    return jobs.get(job);
  };
  const items = [];
  for (const b of tasks) {
    const job = jobOf(b.where);
    items.push({ type: "task", trail: b.trail, job, plan: await planOf(job), summary: b.summary, by: b.by, to: b.to, due: b.walkthrough?.due ?? null, created_at: b.created_at ?? null, steps: (b.walkthrough?.steps || []).length, steps_done: (b.steps_done || []).length, task: b });
  }
  for (const a of decisions) {
    const job = jobOf(a.where);
    items.push({ type: "decision", trail: a.trail, job, plan: await planOf(job), summary: a.summary, by: a.by, due: null, created_at: a.ts, ask: a });
  }
  // Soonest due first; no due date sorts after, oldest first.
  items.sort((x, y) => (x.due && y.due ? String(x.due).localeCompare(String(y.due)) : x.due ? -1 : y.due ? 1 : (x.created_at || 0) - (y.created_at || 0)));
  return { person, count: items.length, items };
}

/** Mission control (live app spec, Home): plans, blocked jobs with their reasons, agents' Now. */
export async function homeView(store, r, space, { secret, person, now = Date.now() } = {}) {
  const ids = await store.list("job");
  const jobs = (await inBatches(ids, 25, async (id) => {
    try {
      const [who, n] = await Promise.all([store.getWho("job", id), store.getNow("job", id)]);
      return who ? { id, who, now: n || {} } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const registered = await listPlans(store);
  const names = [...new Set([...registered, ...jobs.map((j) => j.who.plan).filter(Boolean)])];
  const plans = [];
  for (const name of names) {
    const mine = jobs.filter((j) => j.who.plan === name);
    const work = mine.filter((j) => j.who.milestone !== true);
    const done = work.filter((j) => j.now.stage === "done").length;
    const next = mine
      .filter((j) => j.who.milestone === true && j.now.stage !== "done")
      .sort((a, b) => String(a.who.date || "").localeCompare(String(b.who.date || "")))[0];
    const rec = registered.includes(name) ? await getPlan(store, name) : null;
    plans.push({
      id: name, title: rec?.title || name, lane: rec?.lane || null, jobs: work.length, done,
      parked: work.filter((j) => j.now.stage === "blocked" && j.now.blocked_on?.parked === true).length,
      percent: work.length ? Math.round((done / work.length) * 100) : 0,
      blocked: work.filter((j) => j.now.stage === "blocked" && j.now.blocked_on?.parked !== true).length,
      next_milestone: next ? { id: next.id, title: next.who.title || next.id, date: next.who.date || null } : null,
    });
  }
  // P0 lane first, then active, then parked; "general" last: it is the pile to file, not a plan of record.
  const rank = (p) => (p.id === "general" ? 9 : { p0: 0, active: 1, parked: 3 }[p.lane?.status] ?? 2);
  plans.sort((a, b) => rank(a) - rank(b) || b.jobs - a.jobs);
  const blocked = jobs
    .filter((j) => j.now.stage === "blocked" && j.now.blocked_on?.parked !== true)
    .map((j) => ({
      id: j.id, title: j.who.title || j.id, plan: j.who.plan || null, track: j.who.track || null,
      owner: j.now.owner || j.who.owner || null, blocked_on: j.now.blocked_on || null, since: j.now.stage_at || null,
      waits: Array.isArray(j.now.waits) ? j.now.waits : [],
    }))
    // No reason first (it needs a person to ask), then the longest blocked.
    .sort((a, b) => (!!a.blocked_on - !!b.blocked_on) || (a.since || 0) - (b.since || 0));
  const agentIds = await store.list("agent");
  const agents = (await inBatches(agentIds, 25, async (id) => {
    try {
      const [n, last] = await Promise.all([store.getNow("agent", id), store.readLog("agent", id, { reverse: true, limit: 1 })]);
      return { id, doing: n?.doing ?? null, job: n?.job ?? null, blocked: n?.blocked ?? null, next: n?.next ?? null, seen: seen(last[0]?.ts, now) };
    } catch {
      return null;
    }
  })).filter(Boolean);
  const order = { active: 0, idle: 1, offline: 2, unknown: 3 };
  agents.sort((a, b) => (order[a.seen.state] ?? 9) - (order[b.seen.state] ?? 9) || a.id.localeCompare(b.id));
  const needs = await needsView(store, r, space, { secret, person });
  return { plans, blocked, parked_count: jobs.filter((j) => j.now.stage === "blocked" && j.now.blocked_on?.parked === true).length, agents, needs_count: needs.count };
}

/**
 * The Lanes board (lanes spec): every plan as a lane with its status, what is
 * moving in it, what is blocked, and what is parked inside it on purpose.
 */
export async function lanesView(store) {
  const ids = await store.list("job");
  const jobs = (await inBatches(ids, 25, async (id) => {
    try {
      const [who, n] = await Promise.all([store.getWho("job", id), store.getNow("job", id)]);
      return who ? { id, who, now: n || {} } : null;
    } catch {
      return null;
    }
  })).filter(Boolean);
  const recs = await getPlans(store);
  const names = [...new Set([...recs.map((p) => p.id), ...jobs.map((j) => j.who.plan).filter(Boolean)])];
  const slimJob = (j) => ({ id: j.id, title: j.who.title || j.id, owner: j.now.owner || j.who.owner || null, track: j.who.track || null, since: j.now.stage_at || null, blocked_on: j.now.blocked_on || null });
  const lanes = names.map((name) => {
    const rec = recs.find((p) => p.id === name) || null;
    const mine = jobs.filter((j) => j.who.plan === name);
    const work = mine.filter((j) => j.who.milestone !== true);
    const done = work.filter((j) => j.now.stage === "done").length;
    const isParked = (j) => j.now.stage === "blocked" && j.now.blocked_on?.parked === true;
    const next = mine.filter((j) => j.who.milestone === true && j.now.stage !== "done").sort((a, b) => String(a.who.date || "").localeCompare(String(b.who.date || "")))[0];
    const latest = (xs) => xs.sort((a, b) => (b.now.stage_at || 0) - (a.now.stage_at || 0));
    return {
      id: name, title: rec?.title || name, desc: rec?.desc || null, lane: rec?.lane || null,
      jobs: work.length, done, percent: work.length ? Math.round((done / work.length) * 100) : 0,
      active: latest(work.filter((j) => j.now.stage === "active")).slice(0, 5).map(slimJob),
      active_count: work.filter((j) => j.now.stage === "active").length,
      blocked_count: work.filter((j) => j.now.stage === "blocked" && !isParked(j)).length,
      parked_jobs: latest(work.filter(isParked)).map(slimJob),
      next_milestone: next ? { id: next.id, title: next.who.title || next.id, date: next.who.date || null } : null,
    };
  });
  const rank = (l) => (l.id === "general" ? 9 : { p0: 0, active: 1, parked: 3 }[l.lane?.status] ?? 2);
  lanes.sort((a, b) => rank(a) - rank(b) || b.jobs - a.jobs);
  return { lanes, p0: lanes.find((l) => l.lane?.status === "p0")?.id || null };
}

export async function buildView(redis, space, what, params = {}, now = Date.now(), { secret = process.env.LOGMEM_DECIDE_SECRET } = {}) {
  const r = readOnly(redis);
  const verify = { secret, space };
  const store = createStore(r, { space });
  /** Registry + claims for the asks in `rows`, plus the canonical asks (one rule for every view). */
  const stateOf = async (rows) => {
    const st = await askState(store, rows);
    return { ...st, canon: canonicalAsks(rows, st.registry, viewDigest) };
  };
  const withState = async (rows) => decisionsFrom(rows, { ...verify, ...(await askState(store, rows)) });
  // Decided rows that don't answer their canonical ask are shown marked unverified.
  const annotate = async (rows, asks = rows) => annotateDecisions(rows, { ...verify, canon: (await stateOf(asks)).canon });

  if (what === "home") return homeView(store, r, space, { secret, person: params.person, now });
  if (what === "lanes") return lanesView(store);
  if (what === "needs") return needsView(store, r, space, { secret, person: params.person });

  if (what === "log") {
    const entries = await allEntries(store, r, space, { limit: 200 });
    const picked = params.where ? entries.filter((e) => e.where === params.where) : entries;
    return { entries: await annotate(picked, entries) };
  }

  if (what === "agents" || what === "overview") {
    const ids = await store.list("agent");
    const agents = [];
    for (const id of ids) {
      try {
        const [who, nowSlot, last, recap, shifts] = await Promise.all([
          store.getWho("agent", id), store.getNow("agent", id), store.readLog("agent", id, { reverse: true, limit: 1 }), store.getRecap(id), store.recentShifts(id, 1),
        ]);
        agents.push({ id, who, now: nowSlot, last: last[0] ? slim(last[0], `agent:${id}`) : null, seen: seen(last[0]?.ts, now), recap: recap ? { summary: recap.summary, mode: recap.mode, reason: recap.reason, ended_at: recap.ended_at } : null, shift: shifts[0] || null });
      } catch {
        continue;
      }
    }
    agents.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
    if (what === "agents") return { agents };
    const jobs = await jobsView(store);
    const entries = await allEntries(store, r, space, { limit: 300 });
    const decisions = await withState(entries);
    return {
      agents, jobs, recent: await annotate(entries.slice(0, 8), entries), waiting: decisions.waiting,
      stats: {
        active: agents.filter((a) => a.seen.state === "active").length, agents: agents.length,
        open: jobs.filter((j) => j.stage !== "done").length, stuck: jobs.filter((j) => j.stage === "blocked").length,
        waiting: decisions.waiting.length,
      },
    };
  }

  if (what === "agent") {
    const id = checkAgentId(String(params.id || ""), "id");
    const [who, nowSlot, log, recap, follows, shifts] = await Promise.all([
      store.getWho("agent", id), store.getNow("agent", id), store.readLog("agent", id, { reverse: true, limit: 50 }), store.getRecap(id), store.follows(id), store.recentShifts(id, 8),
    ]);
    // Accepted and declined both settle a handoff (same rule as the Brief: boolean true only).
    const settled = new Set(log.filter((e) => e.origin && (e.kind === "accepted" || (e.kind === "feedback" && isDeclined(e.payload)))).map((e) => e.origin));
    const slimLog = log.map((e) => slim(e, `agent:${id}`));
    return { id, who, now: nowSlot, recap, follows, shifts, log: await annotate(slimLog), handoffs: log.filter((e) => e.kind === "handoff" && e.to === `agent:${id}` && !settled.has(e.trail)).map((e) => slim(e, `agent:${id}`)), seen: seen(log[0]?.ts, now) };
  }

  if (what === "jobs") return { jobs: await jobsView(store) };

  if (what === "plan") return planView(store, String(params.id || ""));

  if (what === "job") {
    const id = String(params.id || "");
    const [who, nowSlot, log, sessions] = await Promise.all([store.getWho("job", id), store.getNow("job", id), store.readLog("job", id, { reverse: true, limit: 100 }), store.jobSessions(id)]);
    const slimLog = log.map((e) => slim(e, `job:${id}`));
    // Open asks are computed here with the same rule as the Decisions page, not in the browser.
    const decisions = await withState(slimLog);
    return { id, who, now: nowSlot, log: await annotate(slimLog), open_asks: decisions.waiting, shifts: sessions };
  }

  if (what === "channels") {
    const ids = await store.list("channel");
    const channels = [];
    for (const id of ids) {
      try {
        const last = await store.readLog("channel", id, { reverse: true, limit: 1 });
        channels.push({ id, last: last[0] ? slim(last[0], `channel:${id}`) : null });
      } catch {
        continue;
      }
    }
    const pick = params.id || channels[0]?.id;
    const log = pick ? (await store.readLog("channel", pick, { reverse: true, limit: 100 })).map((e) => slim(e, `channel:${pick}`)) : [];
    return { channels, selected: pick || null, log };
  }

  if (what === "decisions") return withState(await allEntries(store, r, space, { limit: 500 }));

  if (what === "recall") {
    const q = String(params.q || "").slice(0, 200);
    return q ? { query: q, ...(await keywordRecall(store, q, 20)) } : { query: "", mode: "keyword", results: [] };
  }

  if (what === "audit") return buildScorecard(redis, space);

  if (what === "settings") {
    const keys = await scanKeys(r, `lm:${space}:*`);
    const t0 = Date.now();
    await r("PING");
    return { space, keys: keys.length, ping_ms: Date.now() - t0, compat: ["1","true","yes"].includes(String(process.env.LOGMEM_ACMI_COMPAT || "").toLowerCase()), mirror: ["1","true","yes"].includes(String(process.env.LOGMEM_MIRROR_ACMI || "").toLowerCase()), mirror_spaces: (process.env.LOGMEM_MIRROR_SPACES || "madez").split(",") };
  }

  throw new Error(`unknown view: ${what}`);
}

/**
 * A plan: jobs whose Who has plan=<name>, grouped by track, with milestones.
 * Job Who fields (set with logmem_assign details): plan, track, gate, due,
 * desc, and for a milestone job: milestone=true, date, criteria. Stage comes
 * from Now. Percent is done over total. Spec: 2026-10-19 blockers and plans.
 */
export async function planView(store, name) {
  const ids = await store.list("job");
  const names = new Set();
  const rows = (await inBatches(ids, 25, async (id) => {
    try {
      const [who, nowSlot] = await Promise.all([store.getWho("job", id), store.getNow("job", id)]);
      if (!who?.plan) return null;
      return { id, who, stage: nowSlot.stage || "open", owner: nowSlot.owner || who.owner || null, blocked_on: nowSlot.blocked_on || null };
    } catch {
      return null;
    }
  })).filter(Boolean);
  for (const r of rows) names.add(String(r.who.plan));
  const plans = [...names].sort();
  // Open on the named plan, else the first real plan; "general" only when it is all there is.
  const plan = name && names.has(name) ? name : plans.find((p) => p !== "general") || plans[0] || null;
  const mine = rows.filter((r) => String(r.who.plan) === plan);
  const milestones = mine
    .filter((r) => r.who.milestone === true)
    .map((r) => ({ id: r.id, title: r.who.title || r.id, date: r.who.date || null, criteria: r.who.criteria || "", stage: r.stage }))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const tracks = new Map();
  for (const r of mine.filter((x) => x.who.milestone !== true)) {
    const t = String(r.who.track || "Other");
    if (!tracks.has(t)) tracks.set(t, []);
    // "milestone" (the milestone it counts toward) replaced "gate"; old jobs keep gate.
    const milestone = typeof r.who.milestone === "string" ? r.who.milestone : r.who.gate || null;
    tracks.get(t).push({ id: r.id, title: r.who.title || r.id, desc: r.who.desc || "", milestone, gate: milestone, due: r.who.due || null, owner: r.owner, stage: r.stage, blocked_on: r.blocked_on, evidence: r.who.evidence || "" });
  }
  const pct = (items) => (items.length ? Math.round((items.filter((i) => i.stage === "done").length / items.length) * 100) : 0);
  const trackList = [...tracks.entries()].map(([title, items]) => ({ title, percent: pct(items), items }));
  const all = trackList.flatMap((t) => t.items);
  const rec = plan ? await getPlan(store, plan) : null;
  return { plans, plan, title: rec?.title || plan, desc: rec?.desc || null, lane: rec?.lane || null, percent: pct(all), milestones, tracks: trackList };
}

async function jobsView(store) {
  const ids = await store.list("job");
  // Batched, not one at a time: a REST bridge answers ~25 reads at once far faster than in series.
  const jobs = (await inBatches(ids, 25, async (id) => {
    try {
      const [who, nowSlot, last] = await Promise.all([store.getWho("job", id), store.getNow("job", id), store.readLog("job", id, { reverse: true, limit: 1 })]);
      return {
        id, title: who?.title || id, owner: nowSlot.owner || who?.owner || null, stage: nowSlot.stage || "open", due: who?.due || null,
        plan: who?.plan || null, track: who?.track || null, milestone: who?.milestone === true ? true : typeof who?.milestone === "string" ? who.milestone : who?.gate || null,
        blocked_on: nowSlot.blocked_on || null, stage_at: nowSlot.stage_at || null,
        last: last[0] ? slim(last[0], `job:${id}`) : null,
      };
    } catch {
      return null;
    }
  })).filter(Boolean);
  jobs.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
  return jobs;
}

/**
 * Waiting = canonical asks with no settling answer; decided = canonical asks
 * with one. The same rule as the Brief (tools.mjs decisionsFor): only the
 * ask whose content hash matches the ask registry counts (twins and legacy
 * rows are dropped), only a signed decision bound to that ask's hash counts,
 * the settling decision held by the set-once claim wins, and a defer keeps
 * the ask waiting (marked deferred).
 */
export function decisionsFrom(entries, { secret, space, registry, claims } = {}) {
  const canon = canonicalAsks(entries, registry, viewDigest);
  const { answers, deferrals } = decisionsFor(canon, entries, { secret, space, claims });
  const asks = [...canon.values()].map((c) => c.ask).sort((a, b) => b.ts - a.ts);
  const mark = (a) => {
    const d = deferrals.get(a.trail);
    return d ? { ...a, deferred: { by: d.by, note: d.payload?.note ?? null, at: d.ts } } : a;
  };
  return {
    waiting: asks.filter((a) => !answers.has(a.trail)).map(mark),
    decided: asks.filter((a) => answers.has(a.trail)).map((a) => ({ ask: a, answer: answers.get(a.trail) })),
  };
}
