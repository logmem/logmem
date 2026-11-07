// admin-notes.js: the mode strip and the risky-action text shared by the operator pages.
// A page says plainly whether it can change anything, and what a risky button does before it is pressed.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { SETTINGS_NOTE, AUDIT_NOTE, INVITE_RISK, inviteAllLabel, inviteAllQuestion } from './admin-notes-model.js';
export { SETTINGS_NOTE, AUDIT_NOTE, INVITE_RISK, inviteAllLabel, inviteAllQuestion };


export const viewOnlyNote = (text) => html`<p class="lmx-modestrip" data-mode="view" role="note"><span class="lm-badge lm-badge--info">View only</span> ${text}</p>`;
export const riskNote = (text, label = 'Sends email') => html`<p class="lmx-modestrip" data-mode="risk" role="note"><span class="lm-badge lm-badge--warning">${label}</span> ${text}</p>`;

/** Two-step bulk invite: the first press asks, the second sends. No native dialog. */
export const inviteAllConfirm = ({ count, onSend, onCancel }) => html`<span class="lmx-confirm" role="group" aria-label="Confirm bulk invite"><span>${inviteAllQuestion(count)}</span><button type="button" class="lm-btn lm-btn--primary" @click=${onSend}>Send ${count}</button><button type="button" class="lm-btn lm-btn--ghost" @click=${onCancel}>Cancel</button></span>`;
