// profile-model.js — pure helpers for the agent profile page. No DOM. Every function takes the rows
// the agent view returns and gives back plain data, so node can test it.
const FOCUS = ['doing', 'current', 'job', 'lane', 'next', 'waiting_on', 'blocked_on', 'blocked'];
const META = ['updated_at'];
const clip = (v, n = 220) => { const s = String(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isObj = v => v !== null && typeof v === 'object';
const blank = v => v == null || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Array.isArray(v) && !Object.keys(v).length);

/** A field that may hold text or a small object, such as a pending ask. Text first, then a note, then the id. */
const label = v => (isObj(v) ? clip(v.note || v.summary || v.title || v.text || v.trail || v.id || v.type || '', 120) : String(v || ''));

/** One value from a Now slot, made readable. Objects and lists become rows, never a JSON string. */
export function nowValue(v) {
  if (Array.isArray(v)) return { kind: 'list', rows: v.map(x => clip(isObj(x) ? JSON.stringify(x) : x)) };
  if (isObj(v)) return { kind: 'object', rows: Object.entries(v).map(([k, x]) => [k, clip(isObj(x) ? JSON.stringify(x) : x)]) };
  const text = String(v);
  return { kind: 'text', text, long: text.length > 140 };
}

/** Split a Now slot into the few fields people read first and everything else. */
export function profileNow(slot) {
  const now = slot || {};
  const get = k => (blank(now[k]) ? '' : now[k]);
  const blockedOn = get('blocked_on');
  const blocked = now.blocked === true || !!blockedOn;
  const extras = Object.keys(now).filter(k => !FOCUS.includes(k) && !META.includes(k) && !blank(now[k])).sort().map(key => ({ key, ...nowValue(now[key]) }));
  return {
    doing: String(get('doing') || get('current') || ''),
    job: String(get('job') || '').replace(/^job:/, ''),
    lane: String(get('lane') || ''),
    next: String(get('next') || ''),
    waiting: label(get('waiting_on')),
    blocked, blockedNote: blockedOn ? (isObj(blockedOn) ? String(blockedOn.note || blockedOn.type || 'Blocked') : String(blockedOn)) : '',
    updatedAt: Number(now.updated_at) > 0 ? Number(now.updated_at) : null,
    extras,
  };
}

/** The recap as a headline and the lines after it. */
export function recapParts(recap) {
  if (!recap) return null;
  const lines = String(recap.summary || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return { headline: lines[0] || '', rest: lines.slice(1), next: Array.isArray(recap.next) ? recap.next : [], mode: recap.mode || '', reason: recap.reason || '', endedAt: Number(recap.ended_at) || null };
}

/** Follows grouped by what they point at. Jobs first, channels second. */
export function followGroups(map) {
  const follows = map || {};
  const groups = { job: [], channel: [], other: [] };
  for (const ref of Object.keys(follows).sort()) {
    const [kind, ...rest] = ref.split(':');
    const g = kind === 'job' || kind === 'channel' ? kind : 'other';
    groups[g].push({ ref, id: g === 'other' ? ref : rest.join(':'), role: (follows[ref] || {}).role || '' });
  }
  return groups;
}
export const followCounts = g => ({ all: g.job.length + g.channel.length + g.other.length, job: g.job.length, channel: g.channel.length, other: g.other.length });
export const FOLLOW_SHOW = 12;

/** Shift rows newest first, filtered by how the shift started. */
export function shiftRows(list, filter = 'all') {
  const shifts = list || [];
  const rows = shifts.map(s => ({ shift: String(s.shift || ''), host: String(s.surface || ''), ts: Number(s.ts) || 0, auto: !!s.auto })).sort((a, b) => b.ts - a.ts);
  const counts = { all: rows.length, auto: rows.filter(r => r.auto).length, manual: rows.filter(r => !r.auto).length };
  return { rows: filter === 'auto' ? rows.filter(r => r.auto) : filter === 'manual' ? rows.filter(r => !r.auto) : rows, counts };
}

/** The pills in the header. Only facts the view returned. Nothing is estimated. */
export function profileTelemetry(view = {}) {
  const who = view.who || {}, seen = view.seen || {}, handoffs = view.handoffs || [], follows = view.follows || {}, shifts = view.shifts || [];
  return {
    role: clip(who.role || '', 60),
    state: seen.state || 'unknown',
    since: seen.since || '',
    live: seen.state === 'active',
    waiting: handoffs.length,
    follows: Object.keys(follows).length,
    shifts: shifts.length,
  };
}
