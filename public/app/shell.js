// shell.js — the frame around every view: rail, header, phone tabs, the Needs you count and the
// storage warning banner (crossover from acmi-console's config warning banner).
import { html, render, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { state, live, num, markSeen } from './core.js';
import { icon } from './ui.js';
import { openDrawer } from './drawer.js';
import { openSearch } from './search.js';
import { isSampleSpace, receiptForSpace } from './dashboard-model.js';
import { THEMES, readTheme, writeTheme } from './theme.js';

export const NAV = [['home', 'Today', 'overview'], ['queue', 'Inbox', 'handoff'], ['work', 'Work', 'work'], ['agents', 'Team', 'agents'], ['knowledge', 'Knowledge', 'brief'], ['health', 'Health', 'eye']];
export const ADMIN = [['settings', 'Settings', 'settings', '#/settings'], ['audit', 'Audit', 'eye', '#/audit'], ['waitlist', 'Waitlist', 'globe', '#/waitlist'], ['activity', 'Activity', 'timeline', '#/activity'], ['keys', 'Agent keys', 'link', '/keys'], ['connections', 'Connections', 'link', '/connections']];
const ROUTE_NAV = { plan: 'work', lanes: 'work', jobs: 'work', overview: 'home', agent: 'agents', job: 'work', log: 'activity', channels: 'activity', recall: 'activity', decisions: 'home', blockers: 'home', slots: 'agents' };
export const LIVE_LABEL = { live: 'Data connected', reconnecting: 'Reconnecting…', paused: 'Updates paused' };

// lit-html adds to a container; the first render clears the static "Loading…" placeholder.
const root = () => { const el = document.getElementById('root'); if (!el._$litPart$) el.replaceChildren(); return el; };
let lastRoute = null;
export const currentRoute = () => lastRoute;
let onSpace = () => {}, onSignOut = () => {}, onCreateSpace=()=>{}, onAccount=()=>{};
export function setShellHooks({ space, signOut, createSpace, account }) { onSpace=space;onSignOut=signOut;onCreateSpace=createSpace;onAccount=account; }
/** Sign out from anywhere (the phone has no rail, so More offers it too). */
export function signOut() { onSignOut(); }
const spaceOptions = () => state.spaces.map((s) => html`<option value=${s} ?selected=${s === state.space}>${state.customer?state.spaceRecords.find(x=>x.namespace===s)?.name||s:s}</option>`);
/** The header space picker: shown only below 1024px, where the rail hides its own. */
const workspaceOptions=()=>state.workspaces.filter(w=>state.spaceRecords.some(s=>s.workspaceId===w.id)).map(w=>html`<option value=${w.id} ?selected=${w.id===state.workspaceId}>${w.name}</option>`);
const workspaceSelect=()=>html`<select class="lm-select" aria-label="Workspace" @change=${e=>onSpace(state.spaceRecords.find(s=>s.workspaceId===e.target.value)?.namespace)}>${workspaceOptions()}</select>`;
const headSpace = () => state.customer?html`<div class="lmx-headspace lmx-account-switch-head">${workspaceSelect()}<select class="lm-select" aria-label="Space" @change=${e=>onSpace(e.target.value)}>${spaceOptions()}</select></div>`:state.spaces.length > 1 ? html`<select class="lm-select lmx-headspace" aria-label="Space" @change=${(e) => onSpace(e.target.value)}>${spaceOptions()}</select>` : nothing;

function navItem(n, route) {
  const cur = n[0] === (route === 'discussion' ? 'queue' : ROUTE_NAV[route] || route);
  return html`<a href=${n[3] || '#/' + n[0]} class="lm-nav-item" aria-current=${cur ? 'page' : nothing} style=${cur ? 'background:var(--brand-subtle);color:var(--brand)' : ''} title=${n[1]}>${icon(n[2])}<span>${n[1]}</span></a>`;
}
const needsBtn = () => html`<button type="button" class="lmx-needs" data-n=${live.needs == null ? 'unknown' : num(live.needs)} @click=${() => openDrawer('needs', 'all')} aria-label=${live.needs == null ? 'Needs you: count unavailable' : `Needs you: ${num(live.needs)} items`}>Needs you <b>${live.needs == null ? '—' : num(live.needs)}</b></button>`;
const themePicker = () => html`<label class="lmx-theme-picker"><span>Theme</span><select class="lm-select" aria-label="Theme" @change=${e=>{writeTheme(e.target.value);refreshFrame();}}>${THEMES.map(t=>html`<option value=${t} ?selected=${(document.documentElement.dataset.appTheme||readTheme())===t}>${t[0].toUpperCase()+t.slice(1)}</option>`)}</select></label>`;
function assistant(route) {
  const context = route === 'queue' || route === 'discussion' ? 'Coordination inbox' : route === 'health' || route === 'audit' ? 'Workspace health' : route === 'job' ? 'Selected work' : 'Current space';
  return html`<aside class="lmx-assistant" aria-label="Workspace assistant"><h2>${icon('recall')}Workspace assistant</h2><p class="lmx-assistant-context">${context} · ${state.space}</p><div class="lmx-assistant-card"><span class="lm-eyebrow">Start with the source</span><h3>Keep the next step clear.</h3><p>Review unanswered requests, check ownership and open the original discussion before changing work.</p><a class="lm-btn lm-btn--primary" href="#/queue">Review your inbox</a></div><div class="lmx-assistant-links"><a href="#/knowledge">Find decisions and shared context</a><a href="#/health">Check receipts and coverage</a><a href="#/activity">Read source activity</a></div><div class="lmx-assistant-card"><h3>AI execution is not connected.</h3><p>These links use your existing workspace. No model calls or agent runs start when you open this page.</p><a href=${state.customer?'#/account':'/connections'}>Manage connections</a></div></aside>`;
}
const banner = () => live.storageDown ? html`<div class="lm-alert lm-alert--danger lmx-banner" role="alert">${icon('alert')}<div><strong>LogMem can’t reach its storage.</strong> What you see may be out of date, and nothing you do will save until it is back. The app keeps trying.</div></div>` : nothing;

function frame(route, crumbs, body) {
  const demo = isSampleSpace(state.space)||Boolean(state.spaceRecords.find(s=>s.id===state.spaceId)?.sampleTemplate);
  const receipt = receiptForSpace(live.decisionReceipt, state.space);
  const tab = (id, label, ic) => { const cur = id === (ROUTE_NAV[route] || route); return html`<a href=${'#/' + id} aria-current=${cur ? 'page' : nothing}>${icon(ic)}${label}</a>`; };
  return html`<div class="lmx"><nav class="lmx-rail" aria-label="LogMem">
      <div class="lm-rail-brand"><a href="/" style="display:flex"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:26px;width:auto"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:26px;width:auto"></a></div>
      ${state.customer?html`<div class="lmx-account-switch">${workspaceSelect()}</div>`:nothing}
      <label class="lm-field" style="margin:4px 4px 12px"><span class="lm-label">Space</span><select class="lm-select" aria-label="Space" @change=${(e) => onSpace(e.target.value)}>${spaceOptions()}</select></label>
      ${state.customer?html`${state.workspaces.find(w=>w.id===state.workspaceId)?.role!=='viewer'?html`<button class="lm-btn lm-btn--ghost" @click=${onCreateSpace}>Create space</button>`:nothing}<button class="lm-btn lm-btn--ghost" @click=${onAccount}>Workspace settings</button>`:nothing}
      ${NAV.map((n) => navItem(n, route))}
      <div class="lm-rail-foot" style="margin-top:auto">${navItem(ADMIN[0], route)}${demo ? html`<span class="lm-badge lm-badge--warning lmx-railtext">Sample space</span>` : html`<span style="font-size:12px" class="subtle lmx-railtext">Workspace</span>`}<button type="button" class="lm-btn lm-btn--ghost lmx-railtext" @click=${onSignOut} style="justify-content:flex-start">Sign out</button></div></nav>
    <div class="lmx-col"><header class="lmx-head"><ol class="lm-crumbs">${crumbs.map((c, i) => html`${i ? html`<li aria-hidden="true">/</li>` : nothing}<li aria-current=${i === crumbs.length - 1 ? 'page' : nothing} style=${i === crumbs.length - 1 ? 'color:var(--text)' : ''}>${c}</li>`)}</ol>
      ${headSpace()}${themePicker()}${demo?html`<span class="lm-badge lm-badge--warning">Contains sample content</span>`:nothing}<span class="lmx-live" data-s=${live.status}>${LIVE_LABEL[live.status]}</span>
      <button type="button" class="lmx-searchbtn" @click=${openSearch} aria-label="Search (Ctrl or Cmd K)">${icon('search')}<span>Search</span><kbd class="lm-kbd">⌘K</kbd></button>
      ${needsBtn()}<a class="lmx-mobile-settings lm-btn lm-btn--ghost" href=${state.customer?"#/account":"#/settings"} aria-label="Settings">${icon('settings')}</a></header>
      <div class="lmx-workarea"><main class="lmx-main" id="main">${banner()}${receipt ? html`<div class="lm-alert lmx-decision-receipt" role="status"><div><strong>${receipt.verdict === 'approve' ? 'Approval saved. Completion not verified.' : receipt.verdict === 'reject' ? 'Change request saved.' : 'Decision postponed. It stays open with its original age.'}</strong><p>${receipt.summary}</p><span class="lmx-meta">${receipt.job} · ${receipt.trail}</span></div></div>` : nothing}${body}</main>${assistant(route)}</div></div>
    <nav class="lmx-tabs" aria-label="LogMem">${NAV.map(n=>tab(n[0],n[1],n[2]))}</nav></div>`;
}

let last = { route: null, crumbs: [], body: nothing };
/** Render a view. lit-html updates the page in place, so scroll, focus and typed text stay. */
export function renderView(route, crumbs, body) {
  last = { route, crumbs, body };
  render(frame(route, crumbs, body), root());
  lastRoute = route;
  markSeen(route);
  setTitle(route);
}
/** Re-render the frame only (count, live chip, banner) with the current view body. */
// A bare page (sign-in, the walkthrough player) keeps its own title.
export function refreshFrame() { if (!last.route) return; render(frame(last.route, last.crumbs, last.body), root()); setTitle(last.route); }
export function setTitle(route) {
  const label = (NAV.concat(ADMIN).concat([['more', 'More']]).find((n) => n[0] === (ROUTE_NAV[route] || route)) || [0, 'App'])[1];
  document.title = (live.needs ? `(${live.needs}) ` : '') + 'LogMem · ' + label;
}
export function renderBare(tpl) { last = { route: null, crumbs: [], body: nothing }; render(tpl, root()); }
