// account-tables.js: the Settings tables. lit-html only. Handlers come from account.js.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { RENAME_REASON } from './account-model.js';

const copy = (text) => navigator.clipboard.writeText(text).then(() => true).catch(() => false);
const idChip = (id, toast) => html`<button type="button" class="lmx-idchip" title="Copy the ID" aria-label=${'Copy ID ' + id} @click=${async () => toast((await copy(id)) ? 'ID copied.' : 'Select the ID and copy it.')}><code>${id.slice(0, 8)}</code></button>`;
const table = (label, head, body) => html`<div class="lmx-tablewrap"><table class="lmx-table" aria-label=${label}><thead><tr>${head.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${body}</tbody></table></div>`;

export function spacesTable(rows, toast) {
  if (!rows.length) return html`<p class="lmx-meta">No spaces yet.</p>`;
  return table('Spaces', ['Name', 'Slug', 'ID', 'People', 'Actions'], rows.map((r) => html`<tr>
    <th scope="row" data-label="Name">${r.name}${r.sample ? html` <span class="lm-badge lm-badge--warning">Sample</span>` : nothing}</th>
    <td data-label="Slug"><code>${r.slug}</code></td>
    <td data-label="ID">${idChip(r.id, toast)}</td>
    <td data-label="People">${r.members == null ? '—' : r.members}</td>
    <td data-label="Actions"><button type="button" class="lm-btn lm-btn--ghost" disabled title=${RENAME_REASON}>Rename</button></td></tr>`)) ;
}

/** edit(row) returns the access form for one member, built by account.js (it owns the state and calls). */
export function membersTable(rows, { onRemove, form }) {
  if (!rows.length) return html`<p class="lmx-meta">No members yet.</p>`;
  return table('People and access', ['Person', 'Role', 'Spaces', 'Actions'], rows.map((r) => html`<tr>
    <th scope="row" data-label="Person">${r.who}</th>
    <td data-label="Role">${r.roleText}</td>
    <td data-label="Spaces">${r.access}</td>
    <td data-label="Actions"><details class="lmx-rowedit"><summary class="lm-btn lm-btn--ghost">Edit access</summary>${form(r)}</details>
      <button type="button" class="lm-btn lm-btn--ghost" ?disabled=${r.locked} title=${r.locked ? 'Only an owner can remove an owner.' : nothing} @click=${() => onRemove(r)}>Remove</button></td></tr>`));
}

export function agentsTable(rows, { onDisconnect }) {
  if (!rows.length) return html`<p class="lmx-meta">No agents are connected to this space.</p>`;
  return table('Connected agents', ['Agent', 'Type', 'Access', 'Created', 'Actions'], rows.map((r) => html`<tr>
    <th scope="row" data-label="Agent">${r.name}</th><td data-label="Type">${r.kind}</td>
    <td data-label="Access"><span class="lm-badge">${r.access}</span></td><td data-label="Created">${r.created}</td>
    <td data-label="Actions"><button type="button" class="lm-btn lm-btn--ghost" @click=${() => onDisconnect(r)}>Disconnect</button></td></tr>`));
}

export function invitesTable(rows, { onRevoke }) {
  if (!rows.length) return nothing;
  return html`<h3 class="lmx-colhead">Pending invitations</h3>${table('Pending invitations', ['Role', 'Actions'], rows.map((r) => html`<tr><th scope="row" data-label="Role">${r.roleText}</th><td data-label="Actions"><button type="button" class="lm-btn lm-btn--ghost" @click=${() => onRevoke(r)}>Revoke invitation</button></td></tr>`))}`;
}
