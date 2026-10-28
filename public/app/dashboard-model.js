// dashboard-model.js — pure dashboard ordering, summaries, and action validation.
const SAMPLES = new Set(['fieldnotes', 'demo-solo', 'demo-development', 'demo-trades', 'demo-restaurant', 'demo-sales']);
export const isSampleSpace = space => SAMPLES.has(space);
export const workFilterKey = space => 'work:' + String(space || '');
export function groupUpdates(rows, now = Date.now()) {
  const invalid = [], bySource = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.ts) || row.ts > now) { invalid.push(row); continue; }
    const where = row.where || 'Unknown source';
    if (!bySource.has(where)) bySource.set(where, []);
    bySource.get(where).push(row);
  }
  const groups = [...bySource].map(([where, entries]) => ({ where, entries: entries.slice().sort((a,b)=>b.ts-a.ts) }));
  groups.sort((a,b)=>b.entries[0].ts-a.entries[0].ts || a.where.localeCompare(b.where));
  return { groups, invalid };
}

const rank = job => {
  if (job.stage === 'blocked' && job.blocked_on?.parked !== true) {
    return ['decision', 'task'].includes(job.blocked_on?.type) ? 0 : 1;
  }
  return ({ active: 3, open: 4, blocked: 5, done: 6 })[job.stage] ?? 2;
};
const deadline = value => {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(value))) return Infinity;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : Infinity;
};
export function prioritizeWork(jobs, now = Date.now()) {
  void now;
  return jobs.filter(j => j.milestone !== true).slice().sort((a, b) =>
    rank(a) - rank(b) || (deadline(a.due) - deadline(b.due) || 0) || String(a.id).localeCompare(String(b.id)));
}
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
export function briefFor(home) {
  return {
    decisions: Array.isArray(home.needs_items) ? home.needs_items.filter(i => i.type === 'decision').length : null,
    tasks: Array.isArray(home.needs_items) ? home.needs_items.filter(i => i.type === 'task').length : null,
    blocked: Array.isArray(home.blocked) ? home.blocked.length : null,
    total: (home.plans || []).reduce((n, p) => n + count(p.jobs), 0),
    done: (home.plans || []).reduce((n, p) => n + count(p.done), 0),
    partial: home.coverage?.complete !== true,
  };
}
export function decisionProblem(ask, verdict, note = '') {
  if (!['approve', 'reject', 'defer'].includes(verdict)) return 'Choose a valid response.';
  if (verdict === 'approve' && !(typeof ask?.payload?.action === 'string' && ask.payload.action.trim())) {
    return 'The requester must provide the exact action before you can approve.';
  }
  if (verdict === 'reject' && !(typeof note === 'string' && note.trim())) return 'Say what needs to change in the note box.';
  return null;
}

export const receiptForSpace = (receipt, space) => receipt?.space === space ? receipt : null;

/** Show answer controls only when the viewer can act on this request. Server checks still apply. */
export function canAnswerDecision(ask, {person, canApprove}) {
  return Boolean(person?.startsWith('human:') && canApprove && (!ask.to || ask.to === person));
}

// ---- Today: attention cards ----
const HEAD_MAX = 85;
/** Split a long title into a short headline and a body. Short text stays whole. */
export function splitHeadline(text, max = HEAD_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return { head: s, body: '' };
  const cut = /^(.{12,}?)(?::\s|\.\s)/.exec(s);
  if (cut && cut[1].length <= max + 25) return { head: cut[1], body: s.slice(cut[0].length).trim() };
  const at = s.lastIndexOf(' ', max);
  const i = at > 20 ? at : max;
  return { head: s.slice(0, i).trim() + '…', body: s.slice(i).trim() };
}
export const attentionKind = item => item.type === 'decision' ? 'decision' : item.type === 'task' ? 'task' : 'review';
export function attentionCounts(items = []) {
  const c = { all: items.length, decision: 0, task: 0, review: 0 };
  for (const item of items) c[attentionKind(item)]++;
  return c;
}
export const filterAttention = (items = [], kind = 'all') => kind === 'all' ? items : items.filter(item => attentionKind(item) === kind);
/** Plans with no work yet sit behind a toggle so active plans stay in front. */
export function splitPlans(plans = []) {
  const empty = plans.filter(p => p.id !== 'general' && !(Number(p.jobs) > 0));
  return { active: plans.filter(p => !empty.includes(p)), empty };
}

// ---- Plan detail ----
export const PLAN_MODES = [['all', 'All'], ['open', 'Open & active'], ['blocked', 'Blocked'], ['late', 'Late'], ['waiting', 'Waiting on a person'], ['done', 'Done']];
const waitsOnPerson = job => job.stage === 'blocked' && ['decision', 'task'].includes(job.blocked_on?.type);
export function planMatch(job, mode, late = () => false) {
  switch (mode) {
    case 'open': return job.stage === 'open' || job.stage === 'active';
    case 'blocked': return job.stage === 'blocked';
    case 'late': return Boolean(late(job));
    case 'waiting': return waitsOnPerson(job);
    case 'done': return job.stage === 'done';
    default: return true;
  }
}
export function planCounts(items = [], late = () => false) {
  const counts = {};
  for (const [mode] of PLAN_MODES) counts[mode] = items.filter(job => planMatch(job, mode, late)).length;
  return counts;
}
const squash = text => String(text ?? '').trim().replace(/\s+/g, ' ');
/** Merge workstreams whose titles differ only by case or spacing. Other titles stay apart. */
export function mergeTracks(tracks = []) {
  const groups = new Map();
  for (const t of tracks) {
    const key = squash(t.title).toLowerCase();
    const g = groups.get(key) || { variants: [], items: [], source: [] };
    g.variants.push({ title: squash(t.title), n: (t.items || []).length });
    g.items.push(...(t.items || []));
    g.source.push(t);
    groups.set(key, g);
  }
  return [...groups.values()].map(g => {
    const best = g.variants.slice().sort((a, b) => Number(/^[A-Z]/.test(b.title)) - Number(/^[A-Z]/.test(a.title)) || b.n - a.n)[0].title;
    const done = g.items.filter(i => i.stage === 'done').length;
    const percent = g.source.length === 1 && Number.isFinite(g.source[0].percent) ? g.source[0].percent : (g.items.length ? Math.round(100 * done / g.items.length) : 0);
    return { title: best.charAt(0).toUpperCase() + best.slice(1), items: g.items, done, percent };
  });
}

// ---- Work list ----
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 2026-11-10 becomes "Nov 10". Anything else comes back as given. */
export function fmtDue(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(due ?? ''));
  return m ? `${MONTHS[Number(m[2]) - 1] || m[2]} ${Number(m[3])}` : String(due ?? '');
}
/** One label for the due cell: never the date twice. */
export function dueState(job, late = () => false) {
  if (!job.due) return { kind: 'none', text: '—' };
  const text = fmtDue(job.due);
  if (job.stage !== 'done' && late(job)) return { kind: 'late', text: `Overdue · ${text}` };
  return { kind: 'due', text: `Due ${text}` };
}
export const WORK_MODES = [['live', 'Active & blocked'], ['blocked', 'Blocked'], ['active', 'Active'], ['open', 'Open'], ['late', 'Overdue'], ['parked', 'Parked'], ['done', 'Done'], ['all', 'All']];
const parked = job => job.stage === 'blocked' && job.blocked_on?.parked === true;
export function workMatch(job, mode, late = () => false) {
  switch (mode) {
    case 'blocked': return job.stage === 'blocked' && !parked(job);
    case 'active': return job.stage === 'active';
    case 'open': return job.stage === 'open';
    case 'late': return job.stage !== 'done' && Boolean(late(job));
    case 'parked': return parked(job);
    case 'done': return job.stage === 'done';
    case 'all': return true;
    default: return job.stage === 'active' || (job.stage === 'blocked' && !parked(job));
  }
}
export function workCounts(list = [], late = () => false) {
  const counts = {};
  for (const [mode] of WORK_MODES) counts[mode] = list.filter(job => workMatch(job, mode, late)).length;
  return counts;
}
export const trackKey = track => String(track ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
/** One label per track, ignoring case and spacing. Prefer a spelling that starts with a capital. */
export function trackLabels(tracks = []) {
  const best = new Map();
  for (const raw of tracks) {
    const label = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!label) continue;
    const key = label.toLowerCase(), cur = best.get(key);
    if (!cur || (/^[A-Z]/.test(label) && !/^[A-Z]/.test(cur))) best.set(key, label);
  }
  return [...best.values()].map(l => l.charAt(0).toUpperCase() + l.slice(1)).sort();
}
/** The blocker text of a blocked, not parked job. Empty for everything else. */
export const blockerNote = job => (job.stage === 'blocked' && !parked(job) ? String(job.blocked_on?.note ?? '').trim() : '');
/** Blocker texts that two or more jobs share. */
export function sharedBlockers(list = []) {
  const counts = new Map();
  for (const job of list) { const note = blockerNote(job); if (note) counts.set(note, (counts.get(note) || 0) + 1); }
  return new Map([...counts].filter(([, n]) => n >= 2));
}

// ---- Team: roster groups, trail chips, wake prompt ----
const squashText = text => String(text ?? '').replace(/\s+/g, ' ').trim();
/** "39m", "11h", "3d" as hours. "never" and anything odd is Infinity. */
export function sinceHours(since) {
  const m = /^(\d+)\s*([mhd])$/.exec(String(since ?? '').trim());
  if (!m) return Infinity;
  return Number(m[1]) * ({ m: 1 / 60, h: 1, d: 24 })[m[2]];
}
/** Retired, or a shell that never wrote a Now or recap and has been quiet over 12 hours. */
export function agentHidden(a) {
  const now = a.now || {}, text = squashText(now.doing || now.current || now.status);
  if (/^retired\b/i.test(text)) return true;
  return !now.doing && !a.recap && sinceHours(a.seen?.since) > 12;
}
export const AGENT_MODES = [['fleet', 'Active fleet'], ['live', 'Live now'], ['quiet', 'Quiet'], ['nonow', 'No Now set'], ['hidden', 'Retired and empty'], ['all', 'All']];
export function agentMatch(a, mode) {
  const hidden = agentHidden(a), state = a.seen?.state;
  switch (mode) {
    case 'live': return state === 'active';
    case 'quiet': return !hidden && state !== 'active';
    case 'nonow': return !(a.now || {}).doing;
    case 'hidden': return hidden;
    case 'all': return true;
    default: return !hidden;
  }
}
export function agentCounts(agents = []) {
  const counts = {};
  for (const [mode] of AGENT_MODES) counts[mode] = agents.filter(a => agentMatch(a, mode)).length;
  return counts;
}
export const initials = id => String(id ?? '').split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
const LONG_ID = /[A-Za-z][A-Za-z0-9:_-]{23,}/g;
/** Split text into plain parts and long ids (24 or more characters, no spaces). Ids get a short label. */
export function shortenIds(text) {
  const s = String(text ?? ''), parts = [];
  let last = 0;
  for (const m of s.matchAll(LONG_ID)) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index) });
    parts.push({ chip: `…${m[0].slice(-6)}`, full: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts;
}
/** Job name from a Now job field, with any "job:" prefix removed. Objects come back as text. */
export function jobName(job) {
  if (!job) return '';
  return typeof job === 'string' ? job.replace(/^job:/, '').trim() : JSON.stringify(job);
}
export function agentPing(a, space) {
  const now = a.now || {}, since = a.seen?.since && a.seen.since !== 'never' ? `${a.seen.since} ago` : 'never wrote';
  return [
    `Use LogMem in space "${space}" as @${a.id}.`,
    `Your recorded Now (${since}): "${squashText(now.doing) || 'none recorded'}"`,
    `Active job: ${jobName(now.job) || 'none'}`,
    `Recorded next step: "${squashText(now.next) || 'Check open handoffs and update Now'}"`,
    '',
    `Action: run a fleet sync, check any open handoffs directed to @${a.id}, do your recorded next step, and post an updated Now and a receipt.`
  ].join('\n');
}

// ---- Knowledge: decision map and time buckets ----
export const BUCKETS = ['Today', 'Yesterday', 'Earlier this week', 'Earlier'];
export function timeBucket(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return 'Earlier';
  const d = new Date(now), start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 864e5) return 'Yesterday';
  if (ts >= start - 6 * 864e5) return 'Earlier this week';
  return 'Earlier';
}
export function groupDecisions(decided = [], now = Date.now()) {
  const groups = BUCKETS.map(label => ({ label, items: [] }));
  for (const item of decided) groups[BUCKETS.indexOf(timeBucket(item.answer?.ts, now))].items.push(item);
  return groups.filter(g => g.items.length);
}
export const verdictLabel = verdict => ({ approve: 'Approved', reject: 'Changes requested', defer: 'Deferred' })[verdict] || null;
const PALETTE = ['#1f8a83', '#b87d00', '#7b61c9', '#c4573b', '#3b7fc4', '#5a8a3a'];
export function agentColor(id) {
  let h = 0;
  for (const ch of String(id ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
/** Split decision rows: agents with something waiting float up. The rest become one summary line. */
export function splitDecisionRows(rows = []) {
  const count = row => row.nodes.filter(n => n.state === 'pending').length;
  const waiting = rows.filter(r => count(r) > 0).map(r => ({ ...r, pending: count(r) }));
  const clear = rows.filter(r => count(r) === 0).map(r => ({ agent: r.agent, decided: r.nodes.length }));
  return { waiting, clear };
}
/** One row per asking agent, with a node for each waiting or settled decision. Busiest rows first. */
export function decisionGraph(waiting = [], decided = [], { rows = 8, perRow = 14 } = {}) {
  const by = new Map();
  const add = (ask, state) => {
    const id = String(ask?.by ?? 'unknown'), row = by.get(id) || { agent: id, nodes: [] };
    row.nodes.push({ trail: ask?.trail, summary: ask?.summary, ts: Number(ask?.ts) || null, state });
    by.set(id, row);
  };
  waiting.forEach(ask => add(ask, 'pending'));
  decided.forEach(({ ask }) => add(ask, 'decided'));
  const pending = row => row.nodes.filter(n => n.state === 'pending').length;
  return [...by.values()]
    .sort((a, b) => pending(b) - pending(a) || b.nodes.length - a.nodes.length || a.agent.localeCompare(b.agent))
    .slice(0, rows).map(row => ({ ...row, nodes: row.nodes.slice(0, perRow) }));
}
