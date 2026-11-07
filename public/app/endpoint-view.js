// endpoint-view.js: read-only screens for the backend that is still being built (admin plan, phase 5).
// Until an endpoint exists the route says so. It never shows a number the server did not send.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago } from './core.js';
import { readEndpoint } from './data.js';
import { ENDPOINTS, ENDPOINT_KEYS, STATUS_WORD } from './endpoint-model.js';
import { head, table, emptyState } from './ui.js';
import { renderView } from './shell.js';

const when = (iso) => (iso ? ago(Date.parse(iso)) + ' ago' : 'Not recorded');
const count = (n) => (n == null ? '—' : String(n));

const BODIES = {
  integrations: (d) => (d.integrations.length ? table(['Integration', 'Status', 'Last checked', 'Last error'], d.integrations.map((i) => html`<tr><th scope="row">${i.name}</th><td>${STATUS_WORD[i.status]}</td><td>${when(i.checkedAt)}</td><td>${i.lastError || 'None'}</td></tr>`)) : emptyState('No integrations listed.', 'The server returned an empty list.')),
  usage: (d) => html`${d.plan ? html`<p>Plan: <strong>${d.plan.name}</strong>. Space limit: ${count(d.plan.spacesLimit)}.</p>` : emptyState('No plan reported.', 'The server did not name a plan.')}${d.usage.length ? table(['Metric', 'Used', 'Limit'], d.usage.map((u) => html`<tr><th scope="row">${u.metric}</th><td>${count(u.used)}</td><td>${count(u.limit)}</td></tr>`)) : nothing}`,
  sessions: (d) => (d.sessions.length ? table(['Device', 'Last seen', 'This session'], d.sessions.map((s) => html`<tr><th scope="row">${s.device}</th><td>${when(s.lastSeen)}</td><td>${s.current ? 'Yes' : ''}</td></tr>`)) : emptyState('No sessions listed.', 'The server returned an empty list.')),
  platform: (d) => (d.workspaces.length ? table(['Workspace', 'Spaces', 'People'], d.workspaces.map((w) => html`<tr><th scope="row">${w.name}</th><td>${count(w.spaces)}</td><td>${count(w.members)}</td></tr>`)) : emptyState('No workspaces listed.', 'The server returned an empty list.')),
};

export function endpointPage(key, r) {
  const def = ENDPOINTS[key];
  const body = !r.available ? emptyState('Not available yet.', 'This screen turns on when its backend is ready. Nothing is wrong with your account.')
    : r.error ? html`<div class="lm-alert lm-alert--danger" role="alert"><div>${r.error}</div></div>`
    : BODIES[key](r.data);
  renderView(key, [def.title], html`${head(def.title, 'Read only.')}${body}`);
}

export function registerEndpointScreens(pages) {
  for (const key of ENDPOINT_KEYS) pages[key] = async () => endpointPage(key, await readEndpoint(key));
  return pages;
}
