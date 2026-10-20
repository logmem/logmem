// search.js — quick search (Cmd or Ctrl K), a crossover from acmi-console's entity search.
// Jump to any job, agent, lane or view; the last row searches the whole log with Recall.
import { html, render, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { api } from './core.js';
import { openDrawer } from './drawer.js';

let host = null, open = false, items = null, q = '', pick = 0;
const VIEWS = [['Home', '#/home'], ['Lanes', '#/lanes'], ['Jobs', '#/jobs'], ['Agents', '#/agents'], ['Log', '#/log'], ['Settings', '#/settings'], ['Audit', '#/audit'], ['Waitlist', '#/waitlist']];

async function load() {
  const [jobs, agents, lanes] = await Promise.all([api('jobs'), api('agents'), api('lanes')]);
  items = [
    ...(jobs.jobs || []).map((j) => ({ kind: 'Job', label: j.title, sub: [j.plan, j.track, j.id].filter(Boolean).join(' › '), go: () => openDrawer('job', j.id) })),
    ...(agents.agents || []).map((a) => ({ kind: 'Agent', label: a.id, sub: (a.now && a.now.doing) || '', go: () => { location.hash = '#/agent/' + encodeURIComponent(a.id); } })),
    ...(lanes.lanes || []).map((l) => ({ kind: 'Lane', label: l.title, sub: l.id, go: () => { location.hash = '#/plan/' + encodeURIComponent(l.id); } })),
    ...VIEWS.map(([label, href]) => ({ kind: 'View', label, sub: '', go: () => { location.hash = href; } })),
  ];
  draw();
}
function matches() {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (items || []).filter((i) => words.every((w) => (i.label + ' ' + i.sub + ' ' + i.kind).toLowerCase().includes(w))).slice(0, 12);
  if (q.trim()) list.push({ kind: 'Recall', label: `Search the log for “${q.trim()}”`, sub: '', go: () => { location.hash = '#/recall/' + encodeURIComponent(q.trim()); } });
  return list;
}
function choose(i) { closeSearch(); if (i) i.go(); }
function onKey(e, list) {
  if (e.key === 'ArrowDown') { pick = Math.min(list.length - 1, pick + 1); e.preventDefault(); draw(); }
  else if (e.key === 'ArrowUp') { pick = Math.max(0, pick - 1); e.preventDefault(); draw(); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(list[pick]); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
}
function draw() {
  if (!open) return;
  const list = matches();
  if (pick >= list.length) pick = Math.max(0, list.length - 1);
  render(html`<div class="lm-scrim lmx-cmdk-scrim" @click=${(e) => { if (e.target === e.currentTarget) closeSearch(); }}>
    <div class="lm-cmdk lmx-cmdk" role="dialog" aria-modal="true" aria-label="Search LogMem">
      <input class="lm-cmdk-input lm-input" placeholder="Jump to a job, agent, lane or view…" autocomplete="off" spellcheck="false" .value=${q}
        @input=${(e) => { q = e.target.value; pick = 0; draw(); }} @keydown=${(e) => onKey(e, list)} aria-controls="lmx-cmdk-list">
      <ul id="lmx-cmdk-list" role="listbox" class="lmx-cmdk-list">
        ${items == null ? html`<li class="lmx-meta" style="padding:10px">Loading…</li>` : list.length ? list.map((i, n) => html`<li role="option" aria-selected=${n === pick} @click=${() => choose(i)} @mousemove=${() => { if (pick !== n) { pick = n; draw(); } }}>
          <span class="lmx-wait">${i.kind}</span> <b>${i.label}</b>${i.sub ? html` <span class="lmx-meta">${i.sub}</span>` : nothing}</li>`) : html`<li class="lmx-meta" style="padding:10px">Nothing matches.</li>`}</ul>
      <div class="lm-cmdk-foot lmx-meta">↑ ↓ to move · Enter to open · Esc to close</div></div></div>`, host);
}
export function openSearch() {
  if (!host) { host = document.createElement('div'); host.id = 'lmx-search'; document.body.appendChild(host); }
  open = true; q = ''; pick = 0; items = null;
  draw();
  const input = host.querySelector('input'); if (input) input.focus();
  load().catch(() => { items = []; draw(); });
}
export function closeSearch() { open = false; if (host) render(html``, host); }
export const searchOpen = () => open;
