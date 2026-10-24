import {clearInteractions} from './interactions.js';
// main.js — the LogMem web app: hash routes, sign-in, the live pulse and keyboard shortcuts.
// Every view renders through lit-html (escaped templates); no file in public/app writes raw HTML.
import { bootstrapAccount, configureAccount, chooseSpace, showCustomerLogin, showCreateSpace, showAccount, signOutCustomer, showNewTask } from './account.js';
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { state, live, getJSON, invalidateLoads, setSignedOutHook } from './core.js';
import { icon } from './ui.js';
import { setChangedHook, cancelDialogs } from './actions.js';
import { drawRender, drawerOpen, closeDrawer, setSyncHook } from './drawer.js';
import { renderView, refreshFrame, renderBare, setShellHooks, currentRoute, setTitle, LIVE_LABEL } from './shell.js';
import { pages, setOkHook } from './views.js';
import { openSearch, searchOpen, closeSearch } from './search.js';
import { setWalkOkHook, cancelWalkLoads } from './walk.js';

// ─── responses, sign-in ──────────────────────────────────────────────
function ok(d) {
  if (d.__stale) return false;
  if (d.__status === 401) { login(d.error); return false; }
  if(d.permissions)state.permissions=d.permissions;
  if (d.spaces&&!state.customer) { state.spaces = d.spaces; if (!state.space || d.spaces.indexOf(state.space) < 0) state.space = d.space; }
  if (d.__status === 503) { live.storageDown = true; refreshFrame(); }
  if (d.__status !== 200) {
    renderBare(html`<div class="wrap" style="padding-top:48px"><div class="lm-alert lm-alert--danger">${icon('alert')}<div><strong>Couldn’t load this page.</strong> The server said: ${d.error || d.__status}. Nothing on screen was changed. Try again.</div></div></div>`);
    return false;
  }
  if (live.storageDown) { live.storageDown = false; }
  return true;
}
function login(msg) {
  if(state.customer){closeDrawer();closeSearch();cancelDialogs();return showCustomerLogin(msg);}
  live.signedOut = true;
  let err = msg && msg !== 'sign in required' ? msg : '';
  const submit = async (e) => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: e.target.pw.value }), credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { live.signedOut = false; route(); refreshNeeds(); schedule(0); } else { err = j.error || 'Sign-in failed.'; draw(); }
  };
  const draw = () => renderBare(html`<div class="wrap" style="max-width:420px;padding-top:96px;display:flex;flex-direction:column;gap:20px">
    <img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:32px;width:auto;align-self:flex-start"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:32px;width:auto;align-self:flex-start">
    <h1 class="lm-title-1" style="margin:0;font-size:22px">Sign in to LogMem.</h1>
    <form class="lm-panel" style="padding:20px;display:flex;flex-direction:column;gap:12px" @submit=${submit}><div class="lm-field"><label class="lm-label" for="pw">Admin password</label><input class="lm-input" id="pw" name="pw" type="password" autocomplete="current-password" required></div>
      <p role="alert" style="margin:0;font-size:13px;color:var(--danger)">${err}</p><button class="lm-btn lm-btn--primary">Sign in</button></form>
    <p class="subtle" style="font-size:13px;margin:0">The web app reads, and records your answers to asks. Agents write through MCP.</p></div>`);
  draw();
}
setOkHook(ok);
setWalkOkHook(ok);
setSignedOutHook(login);
setShellHooks({
  space: (s) => { clearInteractions();if(state.customer)return chooseSpace(s); if (drawerOpen()) closeDrawer(); state.space = s; live.decisionReceipt = null; live.home = null; live.jobs = null; live.needs = null; try { localStorage.setItem('lm-space', s); } catch (e) { /* storage blocked */ } live.rev = null; route(); refreshNeeds(); },
  createSpace: showCreateSpace, account:()=>{location.hash='#/account';showAccount();},
  signOut: () => state.customer?signOutCustomer():fetch('/api/logout', { method: 'POST' }).then(() => location.reload()),
});

// ─── router ──────────────────────────────────────────────────────────
function route() {
  cancelWalkLoads();
  invalidateLoads();
  if(state.customer&&!state.spaceId)return;
  if(state.customer&&location.hash==='#/account')return showAccount();
  if(state.customer&&location.hash==='#/new-task')return showNewTask();
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  const page = pages[parts[0]] || pages.home;
  return Promise.resolve(page(parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : undefined)).catch((e) => {
    renderBare(html`<div class="wrap" style="padding-top:48px"><div class="lm-alert lm-alert--danger">${icon('alert')}<div><strong>Couldn’t reach LogMem.</strong> ${e.message}</div></div></div>`);
  });
}

// ─── live: the pulse (live app spec, section 6) ──────────────────────
function syncCount() { refreshFrame(); }
setSyncHook(syncCount);
function setLive(s) { if (live.status !== s) { live.status = s; refreshFrame(); } }
const delay = () => (live.fails ? Math.min(60000, 4000 * Math.pow(2, live.fails)) : document.hidden ? 30000 : 4000);
function schedule(ms) { clearTimeout(live.timer); live.timer = setTimeout(pulse, ms == null ? delay() : ms); }
async function pulse() {
  if (!state.space || live.signedOut) return schedule();
  try {
    const j = await getJSON('/api/pulse?space=' + encodeURIComponent(state.space));
    if (j.__stale) return schedule(0);
    if (j.__status === 401) { live.signedOut = true; return; }
    if (j.__status !== 200) throw new Error('pulse ' + j.__status);
    live.fails = 0;
    if (live.storageDown) { live.storageDown = false; refreshFrame(); }
    setLive('live');
    if (live.rev == null) { live.rev = j.rev; if (currentRoute() !== 'home') refreshNeeds(); }
    else if (j.rev !== live.rev) { live.rev = j.rev; changed(); }
  } catch (e) {
    live.fails++;
    setLive('reconnecting');
    // Three misses in a row: say so plainly (the storage banner), rather than fail silently.
    if (live.fails >= 3 && !live.storageDown) { live.storageDown = true; refreshFrame(); }
  }
  schedule();
}
/** Something changed: refresh the view and the panel in place. lit-html keeps focus, typed text and scroll. */
function changed() {
  route();
  if (drawerOpen()) drawRender();
  if (currentRoute() !== 'home' && !drawerOpen()) refreshNeeds();
}
setChangedHook(changed);
async function refreshNeeds() {
  const n = await getJSON('/api/needs?space=' + encodeURIComponent(state.space || ''));
  if (n.__stale) return;
  if (n.__status === 200) { live.needs = n.count; live.stale = Array.isArray(n.stale) ? n.stale : []; syncCount(); }
  else { live.needs = null; syncCount(); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
window.addEventListener('online', () => { live.fails = 0; schedule(0); });

// ─── keyboard: Cmd/Ctrl K search, Escape, j / k through cards ───────
const typing = () => { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox'); };
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchOpen() ? closeSearch() : openSearch(); return; }
  if (e.key === 'Escape' && drawerOpen() && !searchOpen() && !document.querySelector('.lm-dialog')) { closeDrawer(); return; }
  if (typing() || e.metaKey || e.ctrlKey || e.altKey || searchOpen()) return;
  if (e.key !== 'j' && e.key !== 'k') return;
  const scope = drawerOpen() ? document.querySelector('.lmx-drawer') : document.getElementById('main');
  const cards = scope ? [...scope.querySelectorAll('.lmx-card[tabindex]')] : [];
  if (!cards.length) return;
  const i = cards.indexOf(document.activeElement);
  (cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'j' ? 1 : -1)))] || cards[0]).focus();
  e.preventDefault();
});

// Huddle round tables open from any huddle entry in a log.
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-open-huddle]') : null;
  if (!b) return;
  import('./drawer.js').then((m) => m.openDrawer('huddle', b.getAttribute('data-open-huddle'), b.getAttribute('data-where')));
});

configureAccount({ready:()=>{route();refreshNeeds();schedule(0);},closePanels:()=>{closeDrawer();closeSearch();cancelDialogs();cancelWalkLoads();}});
window.addEventListener('hashchange',route);
window.addEventListener('storage',e=>{if(state.customer&&e.key==='lm-account-event')login('You signed out in another tab.');});
(async()=>{const handled=await bootstrapAccount();if(!handled){route();if(state.space)refreshNeeds();schedule(4000);}})().catch(e=>login('Could not connect. Please retry.'));

export { setTitle, renderView, LIVE_LABEL };
