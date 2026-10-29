// ui.js — small display parts shared by every view. All lit-html templates: values are escaped.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { hhmm, ago, agentName, isLate } from './core.js';

export { html, nothing };
export const icon = (n) => html`<i class="lm-i" data-i=${n} aria-hidden="true"></i>`;

const HUES = ['viz-1', 'viz-2', 'viz-3', 'viz-5', 'viz-4', 'viz-6'];
function hue(name) { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
export function agent(by) {
  const n = agentName(by) || '?';
  const human = /^human:/.test(by || '');
  const ini = n.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return html`<span class="lm-agent"><span class="lm-avatar" ?data-human=${human} style=${human ? '' : `background:var(--${hue(n)})`} aria-hidden="true">${ini}</span><span class="lm-agent-name">${n}</span></span>`;
}
export function seenTag(s) {
  const label = { active: 'Wrote in the last 15 min', idle: 'Quiet', offline: 'No recent entries', unknown: 'Never wrote' }[s?.state] || 'Unknown';
  return html`<span class="lm-presence" data-p=${s?.state || 'unknown'}>${label}${s?.since && s.state !== 'unknown' ? ` · ${s.since}` : ''}</span>`;
}
export function fresh(st, age) {
  const f = { fresh: ['check', 'Fresh'], stale: ['clock', 'Stale'], unavailable: ['alert', 'Unavailable'], disconnected: ['unplug', 'Disconnected'] }[st];
  return html`<span class="lm-fresh" data-s=${st}>${icon(f[0])}${f[1]}${age ? ` · ${age}` : ''}</span>`;
}
const DEC = { pending: ['hourglass', 'Pending decision'], approved: ['check', 'Approved'], rejected: ['x', 'Rejected'], deferred: ['defer', 'Deferred'], failed: ['alert', 'Failed'], completed: ['check', 'Completed'], 'in-progress': ['refresh', 'In progress'], blocked: ['pause', 'Blocked'] };
export function decision(st, label) { const d = DEC[st] || ['unknown', st]; return html`<span class="lm-decision" data-d=${st}>${icon(d[0])}${label || d[1]}</span>`; }
const STAGE = { open: ['deferred', 'Open'], active: ['in-progress', 'Active'], blocked: ['blocked', 'Blocked'], done: ['completed', 'Done'] };
export function stage(s) { const x = STAGE[s] || ['deferred', s || 'Open']; return decision(x[0], x[1]); }

export function entry(e) {
  const timestamp = new Date(e.ts), validTime = Number.isFinite(timestamp.getTime());
  return html`<div class="lm-event" data-k=${e.group || ''}>
    <time class="lm-event-time time" datetime=${validTime ? timestamp.toISOString() : nothing}>${hhmm(e.ts)}</time><span class="lm-event-rule" aria-hidden="true"></span>
    <div class="lm-event-main"><div class="lm-event-line"><span class="lm-kind">${e.kind}</span><strong style="font-size:14px">${agentName(e.by)}</strong><span class="lm-event-summary">${e.summary}</span>
      ${e.kind === 'huddle' && e.trail ? html`<button type="button" class="lm-btn lm-btn--ghost" data-open-huddle=${e.trail} data-where=${e.where || ''}>Round table</button>` : nothing}</div>
    <div class="lm-prov"><span>${e.where}</span>${e.trail ? html`<span>trail ${e.trail}</span>` : nothing}${e.origin ? html`<span>↳ origin ${e.origin}</span>` : nothing}${e.via ? html`<span>via ${e.via}</span>` : nothing}${e.unverified ? html`<span>unverified</span>` : nothing}</div></div></div>`;
}
export function entries(list, empty) {
  return list && list.length ? html`<div class="lm-events">${list.map(entry)}</div>` : emptyState(empty || 'No entries yet.', 'Connect an agent and its entries will appear here in order. Nothing is invented while you wait.');
}
export function emptyState(title, body) { return html`<div class="lm-empty" style="max-width:none"><span class="lm-title-3" style="font-size:14px;font-weight:600">${title}</span><span style="font-size:13px">${body}</span></div>`; }
export function panel(title, body, extra) {
  return html`<section class="lm-panel"><div class="lm-panel-head"><h2 class="lm-title-2" style="margin:0;font-size:17px">${title}</h2><span class="lm-spacer"></span>${extra || nothing}</div><div style="padding:12px 20px 16px">${body}</div></section>`;
}
export function kv(obj) {
  const keys = Object.keys(obj || {});
  return keys.length ? html`<dl class="lm-kv">${keys.map((k) => { const v = obj[k]; return html`<dt>${k}</dt><dd>${typeof v === 'object' ? JSON.stringify(v) : v}</dd>`; })}</dl>` : html`<span class="subtle" style="font-size:13px">Nothing set.</span>`;
}
export function table(head, rows) {
  return html`<div class="lm-table-wrap"><table class="lm-table"><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
export function head(title, sub, right) {
  return html`<div class="lmx-pagehead"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : nothing}</div>${right || nothing}</div>`;
}
export const btn = (label, kind, onClick, extra = {}) => html`<button type="button" class="lm-btn lm-btn--${kind}" @click=${onClick} ?disabled=${!!extra.disabled} aria-label=${extra.label || nothing}>${label}</button>`;

// ─── work words ──────────────────────────────────────────────────────
export function dueTag(due, st) { return due ? (isLate(due, st) ? html`<span class="lmx-flag">late · ${due}</span>` : html`due ${due}`) : nothing; }
const WAIT_SHORT = { task: 'waits on a task', decision: 'waits on a decision', external: 'waits outside' };
export function waitsTag(w) { if (!w) return nothing; return html`<span class="lmx-wait" data-w=${w.type}>${w.type === 'agent' ? `waits on ${w.ref || 'an agent'}` : WAIT_SHORT[w.type] || 'waits'}</span>`; }
export const LANE_LABEL = { p0: 'P0', active: 'Active', parked: 'Parked' };
export function laneBadge(l) { return l && l.status ? html`<span class="lmx-lane" data-l=${l.status}>${LANE_LABEL[l.status]}</span> ` : nothing; }
export const joinDot = (parts) => { const xs = parts.filter((p) => p !== '' && p != null && p !== false && p !== nothing); return xs.map((p, i) => (i ? html` · ${p}` : p)); };
export { ago, agentName };
