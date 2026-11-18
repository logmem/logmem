// brief-model.js: pure helpers for the Brief, Inbox and Activity screens. No DOM, so tests cover every rule.
import { attentionKind } from './dashboard-model.js';
import { ticketStatus, isStaleTicket } from './dispatch-model.js';

const DAY = 86400000;
const HOUR = 3600000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const valid = (ts) => { const n = Number(ts); return Number.isFinite(n) && n > 0 ? n : null; };

/** Time rule: relative under 7 days, a date after ("Nov 2", with the year when it differs). */
export function relTime(ts, now = Date.now()) {
  const t = valid(ts); if (t == null) return 'time unknown';
  const diff = now - t;
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  if (diff < DAY) return Math.floor(diff / HOUR) + 'h ago';
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + 'd ago';
  return shortDate(t, now);
}
/** "Nov 2", or "Nov 2, 2025" when the year differs from now. */
export function shortDate(ts, now = Date.now()) {
  const d = new Date(Number(ts)), n = new Date(now);
  if (!Number.isFinite(d.getTime())) return 'date unknown';
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() === n.getFullYear() ? '' : ', ' + d.getFullYear());
}
/** 24h clock, "14:05". */
export function clock24(ts) {
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '--:--';
}
/** Full local time for a hover title, 24h: "2026-11-17 14:05". */
export function fullTime(ts) {
  const d = new Date(Number(ts));
  if (!valid(ts) || !Number.isFinite(d.getTime())) return 'Time unknown';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Brief ───────────────────────────────────────────────────────────
/** Needs-you parts. The total is the sum of the parts, never a separate count. */
export function needsParts(items = []) {
  const parts = { decision: 0, task: 0, review: 0 };
  for (const item of Array.isArray(items) ? items : []) parts[attentionKind(item)]++;
  return { ...parts, total: parts.decision + parts.task + parts.review };
}
/** The one item the promise strip acts on: the oldest decision, then the oldest task, then the oldest review. */
export function topNeed(items = []) {
  const order = { decision: 0, task: 1, review: 2 };
  const list = (Array.isArray(items) ? items : []).slice();
  list.sort((a, b) => order[attentionKind(a)] - order[attentionKind(b)] || (valid(a.created_at) ?? Infinity) - (valid(b.created_at) ?? Infinity));
  return list[0] || null;
}
/** Presence for the agents list. Paused only when the record says so. */
export function presence(agent = {}) {
  if (agent.paused === true) return { state: 'paused', label: 'Paused' };
  const s = agent.seen?.state;
  if (s === 'active') return { state: 'active', label: 'Active' };
  if (s === 'idle') return { state: 'idle', label: 'Idle' };
  return { state: 'offline', label: 'Offline' };
}
/** "updated 5m ago" from the server's seen.since ("5m", "2h", "3d"). */
export function updatedLabel(seen) {
  const since = String(seen?.since || '');
  if (!since || since === 'never') return 'never wrote';
  return /^0m$/.test(since) ? 'updated just now' : 'updated ' + since + ' ago';
}
/** A plan date "2026-10-23" as "Oct 23". Other text passes through. */
export function dayLabel(date, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return date ? String(date) : 'No date';
  return shortDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), now);
}
/** The next dated milestone across plans, earliest first. */
export function nextMilestone(plans = []) {
  const list = (Array.isArray(plans) ? plans : []).filter((p) => p?.next_milestone).map((p) => ({ plan: p.id, ...p.next_milestone }));
  list.sort((a, b) => (a.date ? 0 : 1) - (b.date ? 0 : 1) || String(a.date || '').localeCompare(String(b.date || '')));
  return list[0] || null;
}
/** The four Brief tiles. Each one is a link; a zero is flagged so the view can dim it. */
export function briefTiles({ needs = [], queue = null, agents = [], plans = [] } = {}, now = Date.now()) {
  const p = needsParts(needs);
  const open = Array.isArray(queue?.items) ? queue.items : null;
  const overdue = open ? open.filter((i) => ticketStatus(i, now) === 'overdue').length : null;
  const active = (agents || []).filter((a) => presence(a).state === 'active').length;
  const ms = nextMilestone(plans);
  return [
    { id: 'needs', label: 'Needs you', value: p.total, sub: `${p.decision} ${p.decision === 1 ? 'decision' : 'decisions'} · ${p.task} ${p.task === 1 ? 'task' : 'tasks'} · ${p.review} ${p.review === 1 ? 'review' : 'reviews'}`, href: '#/needs', zero: p.total === 0 },
    { id: 'overdue', label: 'Overdue', value: overdue == null ? '—' : overdue, sub: open ? `of ${open.length} open ${open.length === 1 ? 'handoff' : 'handoffs'}${queue?.nextCursor != null ? ' loaded' : ''}` : 'Inbox unavailable', href: '#/queue/overdue', zero: overdue === 0, tone: overdue > 0 ? 'danger' : '' },
    { id: 'agents', label: 'Agents active', value: active, sub: `of ${(agents || []).length} connected`, href: '#/agents', zero: active === 0 },
    { id: 'milestone', label: 'Next milestone', value: ms ? dayLabel(ms.date, now) : 'None', sub: ms ? ms.title : 'No open milestone', href: ms ? '#/plan/' + encodeURIComponent(ms.plan) : '#/lanes', zero: !ms, small: true },
  ];
}
/** The handoff the Brief shows as "in flight": the oldest open request. */
export function handoffInFlight(items = []) {
  return sortOldestFirst(items)[0] || null;
}

// ─── Inbox ───────────────────────────────────────────────────────────
export const SOON_MS = 6 * HOUR;
export const BUCKETS = [['all', 'All'], ['soon', 'Due soon'], ['overdue', 'Overdue'], ['over48', 'Over 48h']];
/** Which age bucket a request is in. Overdue includes requests over 48 hours late. */
export function inBucket(item, bucket, now = Date.now()) {
  if (bucket === 'all') return true;
  const overdue = ticketStatus(item, now) === 'overdue';
  if (bucket === 'overdue') return overdue;
  if (bucket === 'over48') return overdue && isStaleTicket(item, now);
  if (bucket === 'soon') { const due = valid(item.deadline); return !overdue && due != null && due - now <= SOON_MS; }
  return false;
}
export function bucketCounts(items = [], now = Date.now()) {
  return Object.fromEntries(BUCKETS.map(([k]) => [k, items.filter((i) => inBucket(i, k, now)).length]));
}
/** Oldest request first, by when it was opened. Unknown times go last. */
export function sortOldestFirst(items = []) {
  return (Array.isArray(items) ? items : []).slice().sort((a, b) => (valid(a.created_at) ?? Infinity) - (valid(b.created_at) ?? Infinity) || String(a.id).localeCompare(String(b.id)));
}
/** Honest one-line summary: "2 on time · 6 overdue". Never says clear while anything is open. */
export function queueSummary(items = [], now = Date.now()) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 'No open requests on this page';
  const overdue = list.filter((i) => ticketStatus(i, now) === 'overdue').length;
  return `${list.length - overdue} on time · ${overdue} overdue`;
}
/** Due chip text: "Overdue · due Nov 2", "Due in 3h", "No deadline". */
export function dueChip(item, now = Date.now()) {
  const due = valid(item.deadline);
  if (due == null) return { text: 'No deadline', tone: '' };
  if (ticketStatus(item, now) === 'overdue') return { text: 'Overdue · due ' + (now - due < DAY ? relTime(due, now) : shortDate(due, now)), tone: 'danger' };
  const left = due - now;
  if (left <= 0) return { text: 'Due now', tone: 'warning' };
  const h = Math.floor(left / HOUR);
  return { text: h < 1 ? 'Due in ' + Math.max(1, Math.floor(left / 60000)) + 'm' : h < 48 ? 'Due in ' + h + 'h' : 'Due ' + shortDate(due, now), tone: left <= SOON_MS ? 'warning' : '' };
}

// ─── Activity ────────────────────────────────────────────────────────
export const KIND_GROUPS = [['work', 'Work'], ['handoff', 'Handoffs'], ['decision', 'Decisions'], ['signal', 'Signals'], ['error', 'Problems'], ['system', 'System']];
/** Newest first, filtered by agent and kind group. */
export function filterActivity(entries = [], { agent = '', kind = '' } = {}, nameOf = (by) => String(by || '')) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => valid(e.ts) != null && (!agent || nameOf(e.by) === agent) && (!kind || (e.group || 'system') === kind))
    .sort((a, b) => Number(b.ts) - Number(a.ts));
}
/** Day groups for a newest-first list: "Today", "Yesterday", then "Mon, Nov 10". */
export function dayGroups(entries = [], now = Date.now()) {
  const start = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = start(now), groups = [];
  for (const e of entries) {
    const day = start(Number(e.ts));
    // A day can be 23 or 25 hours long, so "yesterday" allows an hour either way.
    const label = day === today ? 'Today' : today - day > 0 && today - day <= DAY + HOUR ? 'Yesterday' :['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(day).getDay()] + ', ' + shortDate(day, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e); else groups.push({ day, label, entries: [e] });
  }
  return groups;
}
/** A link for an entry's place: a job or a channel. */
export function placeLink(where) {
  const w = String(where || '');
  if (w.startsWith('job:')) return { href: '#/job/' + encodeURIComponent(w.slice(4)), label: w.slice(4) };
  if (w.startsWith('channel:')) return { href: '#/channels/' + encodeURIComponent(w.slice(8)), label: '#' + w.slice(8) };
  if (w.startsWith('agent:')) return { href: '#/agent/' + encodeURIComponent(w.slice(6)), label: w.slice(6) };
  return null;
}
