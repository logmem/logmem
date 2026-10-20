// drawer.js — the side panel over every view: Needs you (with batch answers), one job, or a
// huddle's round table. Rendered with lit-html into one overlay node.
import { html, render, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { api, getJSON, state, live, agentName, ago } from './core.js';
import { emptyState, panel, entries, stage, btn, kv } from './ui.js';
import { decideBatch } from './actions.js';
import { jobWalkthroughs } from './walk.js';

let drawer = null; // { kind: 'needs'|'job'|'huddle', id, where, last, selected: Set }
let host = null;
let syncHook = () => {};
export function setSyncHook(fn) { syncHook = fn; }
export const drawerOpen = () => !!drawer;
export const drawerState = () => drawer;

// Typed notes stay with their own record when the list changes (keyed by space, type and trail).
const needKey = (i) => `${state.space}:${i.type}:${i.trail}`;

function hostEl() {
  if (!host) { host = document.createElement('div'); host.id = 'lmx-overlay'; document.body.appendChild(host); }
  return host;
}
export function openDrawer(kind, id, where) {
  drawer = { kind, id, where, last: document.activeElement, selected: new Set() };
  return drawRender(true);
}
export function closeDrawer() {
  const back = drawer && drawer.last;
  drawer = null;
  document.body.classList.remove('lmx-pinned');
  render(html``, hostEl());
  if (back && back.focus && document.contains(back)) back.focus();
}
const togglePin = () => { document.body.classList.toggle('lmx-pinned'); drawRender(); };

function shell(title, body) {
  const pinned = document.body.classList.contains('lmx-pinned');
  const wide = window.matchMedia('(min-width:1440px)').matches;
  render(html`<div class="lmx-scrim" @click=${closeDrawer}></div>
    <aside class="lmx-drawer" role="dialog" aria-modal="true" aria-labelledby="lmx-dt">
      <div class="lmx-drawer-head"><button type="button" class="lmx-x lmx-back" @click=${closeDrawer} aria-label="Back">←</button><h2 id="lmx-dt">${title}</h2>
        ${wide ? btn(pinned ? 'Unpin' : 'Pin', 'ghost', togglePin) : nothing}<button type="button" class="lmx-x" @click=${closeDrawer} aria-label="Close">×</button></div>
      <div class="lmx-drawer-body">${body}</div></aside>`, hostEl());
}
function focusHead(first) { if (!first) return; const h = hostEl().querySelector('.lmx-drawer .lmx-x:last-child'); if (h) h.focus({ preventScroll: true }); }

export async function drawRender(first = false) {
  if (!drawer) return;
  const want = drawer;
  const { needItem, jobCard } = await import('./cards.js');
  if (want.kind === 'needs') {
    const n = await getJSON('/api/needs?space=' + encodeURIComponent(state.space || ''));
    if (drawer !== want) return;
    if (n.__status !== 200) { shell('Needs you', emptyState('Could not load.', n.error || '')); return; }
    live.needs = n.count; syncHook();
    const tab = want.id === 'tasks' ? 'task' : want.id === 'decisions' ? 'decision' : 'all';
    const items = n.items.filter((i) => tab === 'all' || i.type === tab);
    const count = (t) => n.items.filter((i) => t === 'all' || i.type === t).length;
    const setTab = (id) => () => { want.id = id; want.selected.clear(); drawRender(); };
    const tb = (id, t, label) => html`<button type="button" role="tab" aria-selected=${tab === t} @click=${setTab(id)}>${label} ${count(t)}</button>`;
    // Batch answers (from the sales agent's approvals): pick decisions, answer them in one go.
    const asks = items.filter((i) => i.type === 'decision').map((i) => i.ask);
    const sel = asks.filter((a) => want.selected.has(a.trail));
    const select = { onChange: (a, on) => { on ? want.selected.add(a.trail) : want.selected.delete(a.trail); drawRender(); } };
    const batch = asks.length > 1 ? html`<div class="lmx-acts lmx-batch">
      <label class="lmx-meta"><input type="checkbox" .checked=${sel.length === asks.length} @change=${(e) => { asks.forEach((a) => (e.target.checked ? want.selected.add(a.trail) : want.selected.delete(a.trail))); drawRender(); }}> Select all ${asks.length} decisions</label>
      ${btn(`Approve ${sel.length || ''} selected`, 'primary', () => decideBatch(sel, 'approve'), { disabled: !sel.length })}${btn('Reject selected', 'danger', () => decideBatch(sel, 'reject'), { disabled: !sel.length })}</div>` : nothing;
    shell('Needs you', html`<div class="lmx-tabsbar" role="tablist">${tb('all', 'all', 'All')}${tb('decisions', 'decision', 'Decisions')}${tb('tasks', 'task', 'Tasks')}</div>${batch}
      ${items.length ? repeat(items, needKey, (i) => needItem(i, i.type === 'decision' && asks.length > 1 ? { select: { ...select, checked: want.selected.has(i.trail) } } : {})) : emptyState('Nothing needs you.', 'When an agent asks a decision or hands you a task, it shows here.')}`);
    focusHead(first);
    return;
  }
  if (want.kind === 'huddle') return drawHuddle(want, first);
  const id = want.id;
  const [d, n] = await Promise.all([api('job', { id }), getJSON('/api/needs?space=' + encodeURIComponent(state.space || ''))]);
  if (drawer !== want) return;
  if (d.__status !== 200) { shell(id, emptyState('Could not load this job.', d.error || '')); return; }
  const who = d.who || {}, now = d.now || {};
  // Decisions come from the job view's open_asks: the server decides what is still open, never the browser.
  const mine = (n.items || []).filter((i) => i.job === id && i.type === 'task').concat((d.open_asks || []).map((a) => ({ type: 'decision', trail: a.trail, job: id, plan: who.plan, ask: a })));
  const card = now.stage === 'blocked' ? jobCard({ id, title: who.title || id, plan: who.plan, track: who.track, owner: now.owner || who.owner, blocked_on: now.blocked_on, since: now.stage_at }, { inPanel: true }) : nothing;
  const about = [['Plan', [who.plan, who.track].filter(Boolean).join(' › ')], ['Owner', agentName(now.owner || who.owner || '')], ['Milestone', typeof who.milestone === 'string' ? who.milestone : who.gate], ['Due', who.due], ['What', who.desc], ['Evidence', who.evidence]].filter((x) => x[1]);
  shell(who.title || id, html`${card}${repeat(mine, needKey, (i) => needItem(i))}
    ${panel('About', html`<dl class="lm-kv"><dt>Stage</dt><dd>${stage(now.stage)}</dd>${about.map((x) => html`<dt>${x[0]}</dt><dd>${x[1]}</dd>`)}</dl>`)}
    ${panel('Walkthroughs', jobWalkthroughs(id, d.tasks))}
    ${panel('Log', entries((d.log || []).slice(0, 30)))}`);
  focusHead(first);
}

/** A huddle's round table (from acmi-console's RoundTable): who was asked, who replied, who acked. */
async function drawHuddle(want, first) {
  const d = await api('huddle', { trail: want.id, where: want.where || '' });
  if (drawer !== want) return;
  if (d.__status !== 200) { shell('Huddle', emptyState('Could not load this huddle.', d.error || '')); return; }
  const STATUS = { acked: ['Acked', 'success'], declined: ['Declined', 'danger'], replied: ['Replied', 'info'], pending: ['No reply yet', 'warning'] };
  shell('Round table', html`<section class="lmx-card"><div class="lmx-meta">${agentName(d.huddle.by)} · ${ago(d.huddle.ts)} · ${d.huddle.where}</div><h3>${d.huddle.summary}</h3></section>
    <div class="lmx-meta">${d.participants.filter((p) => p.status !== 'pending').length} of ${d.participants.length} have answered.</div>
    ${d.participants.map((p) => html`<div class="lmx-card lmx-seat" data-key=${'seat:' + p.agent}>
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${p.agent}</b><span class="lm-badge lm-badge--${STATUS[p.status][1]}">${STATUS[p.status][0]}</span></div>
      ${p.reply ? html`<div class="lmx-why">${p.reply.summary} <span class="subtle">${ago(p.reply.ts)}</span></div>` : nothing}</div>`)}
    ${panel('Replies in order', entries(d.replies))}`);
  focusHead(first);
}
export { kv };
