// shell.js — the frame around every view: rail, header, phone tabs, the Needs you count and the
// storage warning banner (crossover from acmi-console's config warning banner).
import { html, render, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { state, live, num, markSeen } from './core.js';
import { icon } from './ui.js';
import { openDrawer } from './drawer.js';
import { openSearch } from './search.js';

export const NAV = [['home', 'Home', 'overview'], ['lanes', 'Lanes', 'work'], ['jobs', 'Jobs', 'work'], ['agents', 'Agents', 'agents'], ['log', 'Log', 'timeline']];
export const ADMIN = [['settings', 'Settings', 'settings', '#/settings'], ['audit', 'Audit', 'eye', '#/audit'], ['waitlist', 'Waitlist', 'globe', '#/waitlist'], ['keys', 'Agent keys', 'link', '/keys'], ['connections', 'Connections', 'link', '/connections']];
const ROUTE_NAV = { plan: 'lanes', overview: 'home', agent: 'agents', job: 'jobs', channels: 'log', recall: 'log', decisions: 'home', blockers: 'home' };
export const LIVE_LABEL = { live: 'Live', reconnecting: 'Reconnecting…', paused: 'Paused' };

// lit-html adds to a container; the first render clears the static "Loading…" placeholder.
const root = () => { const el = document.getElementById('root'); if (!el._$litPart$) el.replaceChildren(); return el; };
let lastRoute = null;
export const currentRoute = () => lastRoute;
let onSpace = () => {}, onSignOut = () => {};
export function setShellHooks({ space, signOut }) { onSpace = space; onSignOut = signOut; }
/** Sign out from anywhere (the phone has no rail, so More offers it too). */
export function signOut() { onSignOut(); }
const spaceOptions = () => state.spaces.map((s) => html`<option ?selected=${s === state.space}>${s}</option>`);
/** The header space picker: shown only below 1024px, where the rail hides its own. */
const headSpace = () => state.spaces.length > 1 ? html`<select class="lm-select lmx-headspace" aria-label="Space" @change=${(e) => onSpace(e.target.value)}>${spaceOptions()}</select>` : nothing;

function navItem(n, route) {
  const cur = n[0] === (ROUTE_NAV[route] || route);
  return html`<a href=${n[3] || '#/' + n[0]} class="lm-nav-item" aria-current=${cur ? 'page' : nothing} style=${cur ? 'background:var(--brand-subtle);color:var(--brand)' : ''} title=${n[1]}>${icon(n[2])}<span>${n[1]}</span></a>`;
}
const needsBtn = () => html`<button type="button" class="lmx-needs" data-n=${num(live.needs)} @click=${() => openDrawer('needs', 'all')} aria-label=${`Needs you: ${num(live.needs)} items`}>Needs you <b>${num(live.needs)}</b></button>`;
const banner = () => live.storageDown ? html`<div class="lm-alert lm-alert--danger lmx-banner" role="alert">${icon('alert')}<div><strong>LogMem can’t reach its storage.</strong> What you see may be out of date, and nothing you do will save until it is back. The app keeps trying.</div></div>` : nothing;

function frame(route, crumbs, body) {
  const demo = state.space === 'fieldnotes';
  const tab = (id, label, ic) => { const cur = id === (ROUTE_NAV[route] || route); return html`<a href=${'#/' + id} aria-current=${cur ? 'page' : nothing}>${icon(ic)}${label}</a>`; };
  return html`<div class="lmx"><nav class="lmx-rail" aria-label="LogMem">
      <div class="lm-rail-brand"><a href="/" style="display:flex"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:26px;width:auto"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:26px;width:auto"></a></div>
      <label class="lm-field" style="margin:4px 4px 12px"><span class="lm-label">Space</span><select class="lm-select" @change=${(e) => onSpace(e.target.value)}>${spaceOptions()}</select></label>
      ${NAV.map((n) => navItem(n, route))}<div class="lmx-sep">Admin</div>${ADMIN.map((n) => navItem(n, route))}
      <div class="lm-rail-foot" style="margin-top:auto">${demo ? html`<span class="lm-badge lm-badge--warning lmx-railtext">Sandbox space</span>` : html`<span style="font-size:12px" class="subtle lmx-railtext">Live space</span>`}<button type="button" class="lm-btn lm-btn--ghost lmx-railtext" @click=${onSignOut} style="justify-content:flex-start">Sign out</button></div></nav>
    <div class="lmx-col"><header class="lmx-head"><ol class="lm-crumbs">${crumbs.map((c, i) => html`${i ? html`<li aria-hidden="true">/</li>` : nothing}<li aria-current=${i === crumbs.length - 1 ? 'page' : nothing} style=${i === crumbs.length - 1 ? 'color:var(--text)' : ''}>${c}</li>`)}</ol>
      ${headSpace()}<span class="lmx-live" data-s=${live.status}>${LIVE_LABEL[live.status]}</span>
      <button type="button" class="lmx-searchbtn" @click=${openSearch} aria-label="Search (Ctrl or Cmd K)">${icon('search')}<span>Search</span><kbd class="lm-kbd">⌘K</kbd></button>
      ${needsBtn()}</header>
      <main class="lmx-main" id="main">${banner()}${body}</main></div>
    <nav class="lmx-tabs" aria-label="LogMem">${tab('home', 'Home', 'overview')}<button type="button" @click=${() => openDrawer('needs', 'all')}>${icon('decisions')}Needs you${live.needs ? html`<b>${num(live.needs)}</b>` : nothing}</button>${tab('lanes', 'Lanes', 'work')}${tab('jobs', 'Jobs', 'work')}${tab('more', 'More', 'settings')}</nav></div>`;
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
