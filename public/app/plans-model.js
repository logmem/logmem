// plans-model.js: pure rules for the Plans page. No DOM, so a unit test covers every rule.
// A plan is the stored "lane" record plus its jobs. Priority words come from labels.js.
import { priorityLabel, priorityRank, priorityOf, PRIORITY_CHOICES, PRIORITY_LABEL } from './labels.js';

const ISO = /^\d{4}-\d{2}-\d{2}/;
/** Today as YYYY-MM-DD, the same clock core.js isLate uses. */
export const todayISO = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** A job is overdue when its due date has passed and it is not done. */
export function isOverdue(job, today = todayISO()) {
  return !!job && typeof job.due === 'string' && ISO.test(job.due) && job.stage !== 'done' && job.due.slice(0, 10) < today;
}
/** Whole days from today to a YYYY-MM-DD date. Negative means past. Null without a date. */
export function daysUntil(date, today = todayISO()) {
  if (typeof date !== 'string' || !ISO.test(date)) return null;
  return Math.round((Date.parse(date.slice(0, 10) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400e3);
}

/** Overdue work per plan, from the Work list (jobs view). Milestone jobs are not counted as work. */
export function overdueByPlan(jobs = [], today = todayISO()) {
  const out = new Map();
  for (const j of jobs) if (j && j.plan && j.milestone !== true && isOverdue(j, today)) out.set(j.plan, (out.get(j.plan) || 0) + 1);
  return out;
}

/**
 * One row per plan for the Plans list: progress, priority, next milestone, blocked and overdue counts.
 * Order: Top priority, Active, Paused, Not set; "general" last; then the plan with more jobs first.
 */
export function planRows(lanes = [], jobs = [], now = Date.now()) {
  const late = overdueByPlan(jobs, todayISO(now));
  const rows = lanes.filter(Boolean).map((l) => {
    const status = l.id === 'general' ? null : priorityOf(l);
    const total = Number(l.jobs) || 0, done = Number(l.done) || 0;
    return {
      id: l.id, title: l.id === 'general' ? 'Not in a plan' : l.title || l.id, general: l.id === 'general',
      status, label: priorityLabel(status), why: l.lane?.why || '', until: l.lane?.until || '',
      done, total, percent: total ? Math.round((done / total) * 100) : 0,
      next: l.next_milestone ? { id: l.next_milestone.id, title: l.next_milestone.title, date: l.next_milestone.date || null } : null,
      blocked: Number(l.blocked_count) || 0, paused: Array.isArray(l.parked_jobs) ? l.parked_jobs.length : 0,
      overdue: late.get(l.id) || 0,
    };
  });
  return rows.sort((a, b) => (a.general - b.general) || priorityRank(a.status) - priorityRank(b.status) || b.total - a.total || String(a.title).localeCompare(String(b.title)));
}

/** Rows split into the four priority groups, in display order. Empty groups are kept so the page can say so. */
export function groupPlanRows(rows = []) {
  const groups = PRIORITY_CHOICES.map(([status, label]) => ({ status, label, rows: rows.filter((r) => r.status === status) }));
  groups.push({ status: null, label: priorityLabel(null), rows: rows.filter((r) => !r.status) });
  return groups;
}

/** The menu choices for one plan: every priority except the one it has. */
export function priorityMenu(status) { return PRIORITY_CHOICES.filter(([s]) => s !== status); }
/** True when the server needs a reason for this change (pausing a plan needs a why). */
export const needsReason = (status) => status === 'parked';
/** The confirmation line after a change. `demoted` is the list the lane API returns. */
export function priorityToast(title, status, demoted = []) {
  const moved = Array.isArray(demoted) && demoted.length ? ` ${demoted.join(', ')} moved to Active.` : '';
  return `${title} is now ${PRIORITY_LABEL[status] || priorityLabel(null)}.${moved}`;
}

/** Jobs that count toward a milestone: by id, or the older "id: title" form. */
export function milestoneJobs(milestone, items = []) {
  if (!milestone) return [];
  return items.filter((i) => i && i.milestone && (i.milestone === milestone.id || String(milestone.title || '').indexOf(i.milestone + ':') === 0));
}

/** Days before the date when a milestone with open jobs reads At risk. */
export const AT_RISK_DAYS = 3;
/**
 * Done when the milestone job is done. Overdue when its date has passed. At risk when a job toward it is
 * blocked or overdue, or the date is within AT_RISK_DAYS and jobs are still open. Otherwise On track.
 */
export function milestoneStatus(milestone, jobs = [], today = todayISO()) {
  if (!milestone) return 'on_track';
  if (milestone.stage === 'done') return 'done';
  const d = daysUntil(milestone.date, today);
  if (d != null && d < 0) return 'overdue';
  const open = jobs.filter((j) => j.stage !== 'done');
  if (open.some((j) => j.stage === 'blocked' || isOverdue(j, today))) return 'at_risk';
  if (d != null && d <= AT_RISK_DAYS && open.length) return 'at_risk';
  return 'on_track';
}

/** The plan detail: milestones in date order with their jobs and status, then the jobs in no milestone. */
export function milestoneTimeline(milestones = [], items = [], today = todayISO()) {
  const used = new Set();
  const steps = [...milestones].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999'))).map((m) => {
    const jobs = milestoneJobs(m, items);
    jobs.forEach((j) => used.add(j.id));
    const done = jobs.filter((j) => j.stage === 'done').length;
    return { milestone: m, jobs, done, open: jobs.length - done, status: milestoneStatus(m, jobs, today), days: daysUntil(m.date, today) };
  });
  return { steps, loose: items.filter((i) => i && !used.has(i.id)) };
}

/** What a blocked job waits on, in plain words. Empty when it is not blocked. */
export function waitsOn(job, name = (x) => x) {
  if (!job || job.stage !== 'blocked') return '';
  const w = job.blocked_on;
  if (!w) return 'Waits on: no reason given';
  if (w.parked) return 'Paused' + (w.note ? ': ' + w.note : '');
  if (w.type === 'agent') return 'Waits on ' + (w.ref ? name(w.ref) : 'an agent');
  if (w.type === 'decision') return 'Waits on a decision';
  if (w.type === 'task') return 'Waits on a person';
  if (w.type === 'external') return 'Waits on something outside the team';
  return 'Waits';
}
