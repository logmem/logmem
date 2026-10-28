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
