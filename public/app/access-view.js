// access-view.js: the one Agent access screen at #/access. Keys and connected apps, for operators and customers.
// Replaces the old /keys and /connections pages and the agents list inside Settings.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { state, getJSON, postJSON, toast, ago } from './core.js';
import { head } from './ui.js';
import { renderView } from './shell.js';
import { dataTable } from './account-tables.js';
import { normalizeAccess, canManageAccess, createBody, validAgent, accessLabel, KEY_HELP, APP_HELP, FRESH_KEY_NOTE, NOT_MANAGER, revokeQuestion, disconnectQuestion } from './access-model.js';

const URL_ = '/api/agent-keys';
let data = normalizeAccess(null), fresh = null, asking = null, error = '', loading = true;
const customerRole = () => state.workspaces.find((w) => w.id === state.workspaceId)?.role;
const who = () => ({ customer: Boolean(state.customer), role: customerRole() });
const when = (t) => (t ? ago(t) : 'Never');

async function reload() {
  const r = await getJSON(URL_);
  if (r.__stale) return;
  loading = false;
  if (r.__status !== 200) { error = 'Could not load agent access. Try again in a minute.'; data = normalizeAccess(null); }
  else { error = ''; data = normalizeAccess(r); }
  draw();
}
async function send(body, done) {
  try { await postJSON(URL_, 'agent-keys', { ...body, requestId: crypto.randomUUID() }); asking = null; if (done) toast(done); await reload(); }
  catch (e) { if (!e.stale) toast(e.message, true); }
}
async function create(ev) {
  ev.preventDefault();
  const f = ev.currentTarget, agent = f.elements.agent.value;
  if (!validAgent(agent)) { error = 'Use lowercase letters, numbers, dots, dashes or underscores. Start with a letter.'; return draw(); }
  const body = createBody({ customer: Boolean(state.customer), agent, space: f.elements.space?.value, label: f.elements.label?.value, readOnly: f.elements.access?.value === 'read' });
  try {
    const r = await postJSON(URL_, 'agent-keys', { ...body, requestId: crypto.randomUUID() });
    fresh = typeof r.key === 'string' ? { agent: body.agent, key: r.key } : null;
    error = '';
    await reload();
  } catch (e) { if (!e.stale) { error = e.message; draw(); } }
}
const copyKey = async (ev) => { const b = ev.currentTarget; try { await navigator.clipboard.writeText(fresh.key); b.textContent = 'Copied'; } catch { b.textContent = 'Select the key and copy it'; } };

const freshPanel = () => (fresh ? html`<section class="lm-panel lmx-fresh" aria-label="New key"><strong>New key for ${fresh.agent}. ${FRESH_KEY_NOTE}</strong><input class="lm-input mono" readonly .value=${fresh.key} aria-label=${'Key for ' + fresh.agent}><div class="lmx-account-actions"><button type="button" class="lm-btn lm-btn--primary" @click=${copyKey}>Copy key</button><button type="button" class="lm-btn" @click=${() => { fresh = null; draw(); }}>Done, hide it</button></div></section>` : nothing);

const form = () => {
  const op = !state.customer;
  return html`<form class="lm-panel lmx-account-form lmx-accessnew" @submit=${create}>
    <label class="lm-field"><span class="lm-label">Agent name</span><input class="lm-input mono" name="agent" required placeholder="codex" pattern="[a-z][a-z0-9_.-]*" autocomplete="off" spellcheck="false"></label>
    ${op ? html`<label class="lm-field"><span class="lm-label">Space</span><select class="lm-select" name="space" required>${data.spaces.map((s) => html`<option>${s}</option>`)}</select></label>
    <label class="lm-field"><span class="lm-label">Label</span><input class="lm-input" name="label" maxlength="80" placeholder="Where the key lives"></label>
    <label class="lm-field"><span class="lm-label">Access</span><select class="lm-select" name="access"><option value="">Read and write</option><option value="read">Read only</option></select></label>` : nothing}
    <button class="lm-btn lm-btn--primary">Create key</button></form>`;
};

const rowAction = (kind, id, name, question, label, body) => (asking?.kind === kind && asking.id === id
  ? html`<span class="lmx-confirm" role="group" aria-label=${'Confirm ' + label}><span>${question}</span><button type="button" class="lm-btn lm-btn--primary" @click=${() => send(body, label === 'revoke' ? 'Key revoked.' : 'App disconnected.')}>${label === 'revoke' ? 'Revoke' : 'Disconnect'}</button><button type="button" class="lm-btn lm-btn--ghost" @click=${() => { asking = null; draw(); }}>Cancel</button></span>`
  : html`<button type="button" class="lm-btn lm-btn--ghost" @click=${() => { asking = { kind, id }; draw(); }}>${label === 'revoke' ? 'Revoke' : 'Disconnect'}</button>`);

const keysTable = () => (data.keys.length ? dataTable('Agent keys', ['Agent', 'Space', 'Label', 'Access', 'Created', 'Actions'], data.keys.map((k) => html`<tr>
  <th scope="row" data-label="Agent"><code>${k.agent}</code></th><td data-label="Space">${k.space || '—'}</td><td data-label="Label">${k.label || '—'}</td>
  <td data-label="Access"><span class="lm-badge">${accessLabel(k.readOnly)}</span></td><td data-label="Created">${when(k.createdAt)}</td>
  <td data-label="Actions">${rowAction('revoke', k.id, k.agent, revokeQuestion(k.agent), 'revoke', { action: 'revoke', id: k.id })}</td></tr>`)) : html`<p class="lmx-meta">No keys yet.</p>`);
const appsTable = () => (data.apps.length ? dataTable('Connected apps', ['App', 'Agent', 'Space', 'Last used', 'Actions'], data.apps.map((a) => html`<tr>
  <th scope="row" data-label="App">${a.app}</th><td data-label="Agent"><code>${a.agent || '—'}</code></td><td data-label="Space">${a.space || '—'}</td><td data-label="Last used">${when(a.lastUsed)}</td>
  <td data-label="Actions">${rowAction('disconnect', a.fid || a.id, a.app, disconnectQuestion(a.app), 'disconnect', { action: 'disconnect', id: a.id || undefined, fid: a.fid || undefined })}</td></tr>`)) : html`<p class="lmx-meta">No apps connected. Add https://logmem.si/mcp in your app to connect one.</p>`);

export function accessScreen(w) {
  if (!canManageAccess(w)) return html`${head('Agent access', 'Keys and apps that can use this workspace.')}<p>${NOT_MANAGER}</p>`;
  return html`${head('Agent access', 'Keys and apps that can read and write your memory.')}
    <p class="lmx-meta">${KEY_HELP}</p>${freshPanel()}${form()}
    ${error ? html`<div class="lm-alert lm-alert--danger" role="alert"><div>${error}</div></div>` : nothing}
    ${loading ? html`<p class="lmx-meta">Loading…</p>` : html`<h2 class="lmx-section-title">Keys</h2>${keysTable()}<h2 class="lmx-section-title">Connected apps</h2><p class="lmx-meta">${APP_HELP}</p>${appsTable()}`}`;
}
function draw() { renderView('access', ['Agent access'], accessScreen(who())); }

export function registerAccess(pages) {
  pages.access = async () => { fresh = null; asking = null; error = ''; loading = canManageAccess(who()); draw(); if (canManageAccess(who())) await reload(); };
  return pages;
}
