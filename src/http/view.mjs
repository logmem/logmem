// view.mjs — read-only views of one space for the web app.
//
// Every Redis call goes through the read-only guard, so the web app cannot
// write even though the deploy holds read-write bridge creds. Views return
// plain JSON shaped for the pages; nothing secret (no tokens, no full URLs).

import { createStore } from "../core/store.mjs";
import { readOnly } from "../lib/read-only.mjs";
import { keywordRecall, verifyDecision, SETTLES } from "../core/tools.mjs";
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

const slim = (e, from) => ({
  ts: e.ts, kind: e.kind, group: groupOf(e.kind), by: e.by, via: e.via, summary: e.summary,
  trail: e.trail, origin: e.origin, where: from, to: e.to,
  payload: e.kind === "approval" ? { action: e.action, reversible: e.reversible } : e.kind === "decided" ? { verdict: e.payload?.verdict ?? null, note: e.payload?.note ?? null, sig: e.payload?.sig ?? null } : undefined,
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
      const sig = `${e.ts}|${e.trail}|${e.summary}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      merged.push(slim(e, `${m[1]}:${m[2]}`));
    }
  }
  merged.sort((a, b) => b.ts - a.ts);
  return merged.slice(0, limit);
}

export async function buildView(redis, space, what, params = {}, now = Date.now(), { secret = process.env.LOGMEM_DECIDE_SECRET } = {}) {
  const r = readOnly(redis);
  const verify = { secret, space };
  const store = createStore(r, { space });

  if (what === "log") {
    const entries = await allEntries(store, r, space, { limit: 200 });
    return { entries: params.where ? entries.filter((e) => e.where === params.where) : entries };
  }

  if (what === "agents" || what === "overview") {
    const ids = await store.list("agent");
    const agents = [];
    for (const id of ids) {
      const [who, nowSlot, last, recap, shifts] = await Promise.all([
        store.getWho("agent", id), store.getNow("agent", id), store.readLog("agent", id, { reverse: true, limit: 1 }), store.getRecap(id), store.recentShifts(id, 1),
      ]);
      agents.push({ id, who, now: nowSlot, last: last[0] ? slim(last[0], `agent:${id}`) : null, seen: seen(last[0]?.ts, now), recap: recap ? { summary: recap.summary, mode: recap.mode, reason: recap.reason, ended_at: recap.ended_at } : null, shift: shifts[0] || null });
    }
    agents.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
    if (what === "agents") return { agents };
    const jobs = await jobsView(store);
    const entries = await allEntries(store, r, space, { limit: 300 });
    const decisions = decisionsFrom(entries, verify);
    return {
      agents, jobs, recent: entries.slice(0, 8), waiting: decisions.waiting,
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
    const accepted = new Set(log.filter((e) => e.kind === "accepted" && e.origin).map((e) => e.origin));
    return { id, who, now: nowSlot, recap, follows, shifts, log: log.map((e) => slim(e, `agent:${id}`)), handoffs: log.filter((e) => e.kind === "handoff" && e.to === `agent:${id}` && !accepted.has(e.trail)).map((e) => slim(e, `agent:${id}`)), seen: seen(log[0]?.ts, now) };
  }

  if (what === "jobs") return { jobs: await jobsView(store) };

  if (what === "job") {
    const id = String(params.id || "");
    const [who, nowSlot, log, sessions] = await Promise.all([store.getWho("job", id), store.getNow("job", id), store.readLog("job", id, { reverse: true, limit: 100 }), store.jobSessions(id)]);
    return { id, who, now: nowSlot, log: log.map((e) => slim(e, `job:${id}`)), shifts: sessions };
  }

  if (what === "channels") {
    const ids = await store.list("channel");
    const channels = [];
    for (const id of ids) {
      const last = await store.readLog("channel", id, { reverse: true, limit: 1 });
      channels.push({ id, last: last[0] ? slim(last[0], `channel:${id}`) : null });
    }
    const pick = params.id || channels[0]?.id;
    const log = pick ? (await store.readLog("channel", pick, { reverse: true, limit: 100 })).map((e) => slim(e, `channel:${pick}`)) : [];
    return { channels, selected: pick || null, log };
  }

  if (what === "decisions") return decisionsFrom(await allEntries(store, r, space, { limit: 500 }), verify);

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

async function jobsView(store) {
  const ids = await store.list("job");
  const jobs = [];
  for (const id of ids) {
    const [who, nowSlot, last] = await Promise.all([store.getWho("job", id), store.getNow("job", id), store.readLog("job", id, { reverse: true, limit: 1 })]);
    jobs.push({ id, title: who?.title || id, owner: nowSlot.owner || who?.owner || null, stage: nowSlot.stage || "open", due: who?.due || null, last: last[0] ? slim(last[0], `job:${id}`) : null });
  }
  jobs.sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
  return jobs;
}

/**
 * Waiting = approval entries with no decided entry whose origin is their trail.
 * Only a signed person's answer counts (written by /api/decide, HMAC verified
 * with LOGMEM_DECIDE_SECRET): an unsigned or forged "decided", including a
 * legacy ACMI row claiming a human source, does not close an ask.
 */
export function decisionsFrom(entries, { secret, space } = {}) {
  const signed = entries.filter((e) => e.kind === "decided" && verifyDecision(e, { secret, space }));
  // Approve / reject settle an ask. Defer does not: the ask stays waiting (and visible), marked deferred.
  const decided = new Map(signed.filter((e) => SETTLES.includes(e.payload?.verdict)).map((e) => [e.origin, e]));
  const deferred = new Map();
  for (const e of [...signed].sort((x, y) => y.ts - x.ts)) if (e.payload?.verdict === "defer" && !deferred.has(e.origin)) deferred.set(e.origin, e);
  const asks = entries.filter((e) => e.kind === "approval");
  const mark = (a) => {
    const d = deferred.get(a.trail);
    return d ? { ...a, deferred: { by: d.by, note: d.payload?.note ?? null, at: d.ts } } : a;
  };
  return {
    waiting: asks.filter((a) => !decided.has(a.trail)).map(mark),
    decided: asks.filter((a) => decided.has(a.trail)).map((a) => ({ ask: a, answer: decided.get(a.trail) })),
  };
}
