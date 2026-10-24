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
