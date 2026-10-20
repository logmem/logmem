// core.js — shared state, data access, formatting and toasts for the LogMem web app.
// Every page is a lit-html template: values are escaped by lit, never concatenated into HTML.

export const state = { space: null, spaces: [] };
try { state.space = localStorage.getItem('lm-space'); } catch (e) { /* storage blocked */ }

// Live app state: the last rev seen, the Needs you count, pulse status, cached view data.
export const live = { rev: null, needs: 0, status: 'live', fails: 0, timer: null, signedOut: false, storageDown: false, jobs: null, log: null, recall: null, home: null };

// ─── time and numbers ────────────────────────────────────────────────
export function hhmm(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return (today ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toISOString().slice(11, 16);
}
export function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago';
}
/** Numbers from the server are coerced, never trusted. */
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const agentName = (by) => String(by || '').replace(/^agent:/, '').replace(/^human:/, '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isLate = (due, st) => !!due && ISO.test(due) && st !== 'done' && due < new Date().toISOString().slice(0, 10);

// ─── data ────────────────────────────────────────────────────────────
async function asJSON(r) {
  const j = await r.json().catch(() => ({}));
  j.__status = r.status;
  return j;
}
export function getJSON(url) { return fetch(url, { credentials: 'same-origin' }).then(asJSON); }
export function api(what, extra) {
  const q = new URLSearchParams(Object.assign({ what }, state.space ? { space: state.space } : {}, extra || {}));
  return getJSON('/api/view?' + q);
}
/** POST with the intent header; resolves the JSON on 2xx, throws the server's message otherwise. */
export async function postJSON(url, intent, body) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': intent }, body: JSON.stringify(Object.assign({ space: state.space }, body)) });
  const j = await asJSON(r);
  if (r.status === 401) onSignedOut(j.error);
  if (r.status >= 300) { const e = new Error(j.error || 'status ' + r.status); e.status = r.status; throw e; }
  return j;
}
let signedOutHook = () => {};
export function setSignedOutHook(fn) { signedOutHook = fn; }
function onSignedOut(msg) { signedOutHook(msg); }

// ─── toasts (plain text nodes: nothing is parsed as HTML) ────────────
export function toast(text, err) {
  let box = document.getElementById('lmx-toasts');
  if (!box) { box = document.createElement('div'); box.id = 'lmx-toasts'; box.className = 'lmx-toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'lmx-toast';
  if (err) t.setAttribute('data-s', 'err');
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
}

// ─── per-view filters, kept for the session ──────────────────────────
let FILTERS = {};
try { FILTERS = JSON.parse(sessionStorage.getItem('lm-filters') || '{}') || {}; } catch (e) { FILTERS = {}; }
export const filt = (view) => FILTERS[view] || (FILTERS[view] = {});
export function saveFilt() { try { sessionStorage.setItem('lm-filters', JSON.stringify(FILTERS)); } catch (e) { /* storage blocked */ } }
export const uniq = (xs) => xs.filter((x, i) => x && xs.indexOf(x) === i).sort();

// ─── new-row glow: a key seen for the first time on a view already shown ──
const seen = new Map();
export function glow(route, key) {
  let s = seen.get(route);
  if (!s) { s = new Set(); s.ready = false; seen.set(route, s); }
  const isNew = s.ready && !s.has(key);
  s.add(key);
  return isNew ? 'lmx-new' : '';
}
export function markSeen(route) { const s = seen.get(route); if (s) s.ready = true; }
