// dispatch-components.js: compact tickets, clipboard feedback and blocker groups.
import {html,nothing} from '/vendor/lit-html-3.2.1/lit-html.js';
import {ticketStatus,ticketPrompt,clusterPrompt,summaryPreview} from './dispatch-model.js';
import {agentName} from './core.js';
const stamp = value => Number(value)>0 && Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString() : 'Unavailable';
// Feedback stays local to this DOM node, so context changes discard private fallback text.
export function agentDispatchButton(prompt, label='Copy prompt') {
  return html`<span class="lmx-dispatch"><button type="button" class="lm-btn lm-btn--secondary lmx-dispatch-button" @click=${async e=>{
    const button=e.currentTarget, host=button.parentElement, feedback=host.querySelector('[role=status]'), fallback=host.querySelector('label');
    const current=()=>host.isConnected&&fallback.querySelector('textarea').value===prompt;
    button.disabled=true; fallback.hidden=true; feedback.textContent='';
    try { await navigator.clipboard.writeText(prompt); if(current())feedback.textContent='✓ Copied dispatch'; }
    catch { if(current()){fallback.hidden=false; feedback.textContent='Clipboard unavailable. Select and copy the prompt below.';} }
    finally { if(host.isConnected)button.disabled=false; }
  }}><span aria-hidden="true">▣</span> ${label}</button><span class="lmx-copy-status" role="status" aria-live="polite"></span><label hidden class="lmx-copy-fallback">Dispatch prompt<textarea readonly aria-label="Dispatch prompt" .value=${prompt}></textarea></label></span>`;
}
export function terminalTicketCard({item,space,actions=nothing,notice=nothing,now=Date.now()}) {
 const status=ticketStatus(item,now);
 return html`<article class="lmx-ticket" data-status=${status} aria-label=${'Request from '+agentName(item.from)+' to '+agentName(item.to)}>
 <header><span class="mono">${item.type} · ${agentName(item.from)} → ${agentName(item.to)}</span><span class="lmx-ticket-status">${status==='overdue'?'Overdue':'Awaiting response'}</span></header>
 <details class="lmx-ticket-body"><summary><span class="lmx-ticket-summary">${summaryPreview(item.summary)}</span><span class="lmx-ticket-expand">Details <span aria-hidden="true">⌄</span></span></summary><div class="lmx-ticket-context"><p>${item.summary}</p><dl><dt>Created</dt><dd>${stamp(item.created_at)}</dd><dt>Deadline</dt><dd>${stamp(item.deadline)}</dd><dt>Last nudge</dt><dd>${item.last_nudge_at?stamp(item.last_nudge_at):'None recorded'}</dd><dt>Source</dt><dd>${item.where}</dd></dl></div></details>
 <footer><time class="lmx-ticket-due">Due ${stamp(item.deadline)}</time><div class="lmx-ticket-actions">${agentDispatchButton(ticketPrompt(item,space))}${actions}</div></footer>${notice}
 </article>`;
}
export function clusterBlockerGroup(cluster, space) {
 return html`<details class="lmx-blocker-group"><summary><strong>${cluster.note}</strong><span>${cluster.jobs.length} loaded jobs</span></summary><div class="lmx-blocker-content"><p>Review each record before changing its blocker.</p><ul>${cluster.jobs.map(j=>html`<li><a href=${'#/job/'+encodeURIComponent(j.id)}>${j.title||j.id}</a> <span class="mono">${j.id}</span></li>`)}</ul>${agentDispatchButton(clusterPrompt(cluster,space),'Copy group prompt')}<p class="lmx-meta">Copy prepares a review prompt. It does not clear blockers or start an agent.</p></div></details>`;
}
