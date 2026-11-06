// canvas-detail-model.js: pure helpers for the JobDetail, agent shift and audit canvas parity items.
// Each helper reads fields the views already return. A missing field gives null or an empty list, so the view hides the row.
const VERBS = ['send', 'email', 'merge', 'deploy', 'publish', 'delete', 'pay', 'spend', 'ship', 'release', 'post', 'archive', 'rotate', 'refund', 'invite', 'remove', 'cancel', 'push', 'transfer', 'sign'];
const strip = (s) => String(s == null ? '' : s).replace(/^(agent|job|channel):/, '');

/** "Approve send" style label: the first action verb in the ask. Plain "Approve" when no verb is named. */
export function approveObject(ask) {
  const text = [ask && ask.summary, ask && ask.payload && ask.payload.action].filter(Boolean).join(' ').toLowerCase();
  const verb = (text.match(/[a-z]+/g) || []).find((w) => VERBS.includes(w));
  return verb ? ' ' + verb : '';
}

/** The visible Reversible line. Null when the ask does not say, so the card hides it. */
export function reversibleLine(ask) {
  const r = ask && ask.payload ? ask.payload.reversible : undefined;
  if (r === true) return { label: 'Reversible?', value: 'Yes', note: 'It can be undone after it runs.' };
  if (r === false) return { label: 'Reversible?', value: 'No', note: 'It cannot be undone after it runs.' };
  return null;
}

/** The Next panel at the top of a job. Null when the job has nothing to say. */
export function jobNext(d) {
  const data = d || {}, now = data.now || {}, asks = Array.isArray(data.open_asks) ? data.open_asks : [];
  if (asks.length) return { who: 'you', text: `Answer the ${asks.length === 1 ? 'decision' : asks.length + ' decisions'} below. The agent waits for your answer.` };
  if (now.stage === 'done') return null;
  const b = now.blocked_on;
  if (now.stage === 'blocked' && b && b.note) return { who: 'blocked', text: String(b.note) };
  const next = typeof now.next === 'string' ? now.next.trim() : '';
  if (next) return { who: strip(now.owner || (data.who && data.who.owner) || '') || 'owner', text: next };
  return null;
}

/** The newest handoff on a job log, with its acceptance when the log has one. */
export function jobHandoff(log) {
  const rows = Array.isArray(log) ? log : [];
  const h = rows.filter((e) => e && e.kind === 'handoff').sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  if (!h) return null;
  const acc = h.trail ? rows.find((e) => e && e.kind === 'accepted' && e.origin === h.trail) : null;
  return {
    from: strip(h.by), to: strip(h.to), ts: h.ts || 0, message: h.summary || '', trail: h.trail || '',
    acceptedTs: acc ? acc.ts || 0 : 0,
    acceptedMin: acc && acc.ts >= h.ts ? Math.max(1, Math.round((acc.ts - h.ts) / 60000)) : null,
  };
}

/** Ended-by and entry count for one shift, from the last recap or the recap entry in the agent log. Nulls when unknown. */
export function shiftEnds(shift, recap, log) {
  const none = { endedBy: null, endedAt: 0, entries: null };
  if (!shift) return none;
  const label = (mode, reason) => mode === 'manual' ? 'Recap (manual)' : mode === 'auto' ? 'Auto recap' + (reason ? ' (' + reason + ')' : '') : null;
  if (recap && recap.shift === shift) {
    return { endedBy: label(recap.mode, recap.reason), endedAt: Number(recap.ended_at) || 0, entries: Number.isFinite(recap.entry_count) ? recap.entry_count : null };
  }
  const e = (Array.isArray(log) ? log : []).find((x) => x && x.kind === 'recap' && x.origin === shift);
  if (!e) return none;
  const m = String(e.summary || '').match(/recap \((auto|manual)(?:, ([^)]*))?\)/);
  const n = String(e.summary || '').match(/(\d+) entries this shift/);
  return { endedBy: m ? label(m[1], m[2] === 'idle' ? '' : m[2]) : null, endedAt: e.ts || 0, entries: n ? Number(n[1]) : null };
}

const DAY = 86400000, ISO = /^\d{4}-\d{2}-\d{2}$/;
const fmt = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** The earliest date the 7-day gate can pass, if every day from now passes. Null when it already passes or the days are missing. */
export function earliestPass(days, gate) {
  if (gate && gate.pass) return null;
  const list = (Array.isArray(days) ? days : []).filter((x) => x && ISO.test(String(x.date))).sort((a, b) => a.date.localeCompare(b.date));
  const last = list.at(-1);
  if (!last) return null;
  let streak = 0, prev = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = Date.parse(list[i].date + 'T00:00:00Z');
    if (list[i].pass !== true || (prev !== null && prev - t !== DAY)) break;
    streak++; prev = t;
  }
  if (streak >= 7) return null;
  const lastMs = Date.parse(last.date + 'T00:00:00Z');
  return { streak, earliest: fmt(lastMs + (7 - streak) * DAY), restart: streak === 0 ? fmt(lastMs + DAY) : null };
}

export const CHECK_JOB = 'logmem-dogfood';
/** Links to the entry behind an audit day. The daily check writes one checkup entry per day on the check job. */
export function evidenceLinks(day) {
  if (!day || !ISO.test(String(day.date)) || day.ran === false) return [];
  return [{ label: 'Checkup entry', href: '#/job/' + encodeURIComponent(CHECK_JOB), trail: 'dogfoodCheck-' + day.date }];
}
