// cards.js — the shared parts (live app spec, section 3): one job card, one plan card, one agent
// chip, one task card, one decision card, one lane card. Every view is built from these.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { num, ago, agentName, glow, toast, state, live } from './core.js';
import { icon, agent, seenTag, stage, decision, btn, dueTag, waitsTag, laneBadge, joinDot } from './ui.js';
import { doWork, doStep, doTask, doLane, decide } from './actions.js';
import { decisionProblem, shortenIds, jobName, initials } from './dashboard-model.js';
import {agentDispatchButton} from './dispatch-components.js';
import {agentDispatchPrompt} from './dispatch-model.js';
import { openDrawer } from './drawer.js';

const openJob = (id) => (e) => { e.preventDefault(); openDrawer('job', id); };
const jobLink = (id, title) => html`<a href=${`#/job/${encodeURIComponent(id)}`} @click=${openJob(id)}>${title}</a>`;
/** Overdue with no entry for 48 hours (the reconciler's last report). */
export const staleTag = (id) => ((live.stale || []).includes(id) ? html`<span class="lm-badge lm-badge--warning" title="Overdue, and nothing written for 48 hours">Stale</span>` : nothing);
const noteBox = (key, ph, required) => html`<input class="lm-input" data-note-for=${key} maxlength="300" placeholder=${ph} aria-label=${ph} ?required=${required}>`;
const WAIT = { task: 'Waits on a task for a person', decision: 'Waits on a decision', agent: 'Waits on agent', external: 'Waits on something outside the team' };

/** A blocked job: what it waits on and one fix button. In the panel, the task or decision is shown below it. */
export function jobCard(b, { route = '', inPanel = false } = {}) {
  const w = b.blocked_on, t = w ? w.type : 'none';
  const why = !w ? html`<span class="lmx-flag">No reason given</span> Ask the owner what it waits on.`
    : t === 'agent' ? html`Waits on <b>${w.ref || 'an agent'}</b>: ${w.note}` : html`${WAIT[t] || 'Waits'}: ${w.note}`;
  const acts = t === 'task' ? (inPanel ? nothing : btn('Open steps', 'primary', openJob(b.id)))
    : t === 'decision' ? (inPanel ? nothing : btn('Answer', 'primary', openJob(b.id)))
    : t === 'agent' ? html`${noteBox(`nudge:${b.id}`, 'Note to the agent (optional)')}${btn('Nudge', 'secondary', (e) => doWork(e, 'nudge', b.id, w.ref))}`
    : t === 'external' ? html`${noteBox(`unblock:${b.id}`, 'Why it can move now', true)}${btn('Unblock', 'secondary', (e) => doWork(e, 'unblock', b.id))}`
    : html`${noteBox(`nudge:${b.id}`, 'Note to the owner (optional)')}${btn('Ask owner why', 'secondary', (e) => doWork(e, 'nudge', b.id))}`;
  return html`<article class="lmx-card lmx-job ${glow(route, 'job:' + b.id)}" tabindex="0" data-key=${'job:' + b.id} data-w=${t}>
    <h3>${jobLink(b.id, b.title)}</h3>
    <div class="lmx-meta">${joinDot([[b.plan, b.track].filter(Boolean).join(' › '), b.owner ? agentName(b.owner) : '', b.since ? 'blocked ' + ago(b.since) : ''])}</div>
    <div class="lmx-why">${why}</div>${acts === nothing ? nothing : html`<div class="lmx-acts">${acts}</div>`}</article>`;
}

export function planCard(p, route) {
  const general = p.id === 'general';
  return html`<a class="lmx-card lmx-plan ${glow(route, 'plan:' + p.id)}" tabindex="0" data-key=${'plan:' + p.id} href=${`#/plan/${encodeURIComponent(p.id)}`} style="text-decoration:none;color:inherit">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>${laneBadge(p.lane)}${general ? 'general' : p.title}</h3>${general ? nothing : html`<span class="lmx-pct">${num(p.percent)}%</span>`}</div>
    ${general ? html`<div class="lmx-why">${num(p.jobs)} ${p.jobs === 1 ? 'job' : 'jobs'} to file in a plan</div>` : html`
      <div class="lmx-bar"><i style=${`width:${num(p.percent)}%`}></i></div>
      <div class="lmx-meta">${num(p.done)} of ${num(p.jobs)} done${p.blocked ? html` · <b style="color:var(--warning)">${num(p.blocked)} blocked</b>` : nothing}${p.parked ? ` · ${num(p.parked)} parked` : ''}</div>
      <div class="lmx-why">${p.next_milestone ? `Next: ${p.next_milestone.title}${p.next_milestone.date ? ' · ' + p.next_milestone.date : ''}` : 'No milestone set'}</div>`}</a>`;
}

export function agentChip(a, route) {
  const since = !a.seen || a.seen.since === 'never' ? 'never wrote' : a.seen.since === '0m' ? 'wrote just now' : `wrote ${a.seen.since} ago`;
  return html`<a class="lmx-card lmx-agent ${glow(route, 'agent:' + a.id)}" tabindex="0" data-key=${'agent:' + a.id} data-p=${a.seen?.state || ''} href=${`#/agent/${encodeURIComponent(a.id)}`} style="text-decoration:none;color:inherit">
    <span class="lmx-dot" aria-hidden="true"></span><div style="min-width:0"><h3>${a.id}</h3>
    <div class="lmx-why">${a.doing ? a.doing : html`<span class="lmx-flag">No Now set</span>`}</div>
    <div class="lmx-meta">${joinDot([since, a.blocked === true ? 'blocked' : ''])}</div></div></a>`;
}

/** A task for a person: steps to tick, Done, Can't do with a reason. */
export function taskCard(i) {
  const b = i.task, w = b.walkthrough || {}, steps = w.steps || [], done = b.steps_done || [];
  return html`<article class="lmx-card" data-key=${'task:' + b.trail}>
    <div class="lmx-meta">Task · ${[i.plan, i.job].filter(Boolean).join(' › ')}</div><h3>${b.summary}</h3>
    <div class="lmx-meta">${joinDot([w.time, w.place, w.due ? 'due ' + w.due : '', 'from ' + agentName(b.by), `${done.length} of ${steps.length} steps`])}</div>
    ${steps.length ? html`<ol class="lmx-steps">${steps.map((st, k) => html`<li>
      <input type="checkbox" .checked=${done.indexOf(k) >= 0} @change=${(e) => doStep(e, b.trail, k, b.rev || 0)} aria-label=${`Step ${k + 1} done`}>
      <div style="min-width:0"><b>${st.title}</b>${st.detail ? html`<div class="lmx-why">${st.detail}</div>` : nothing}
      ${st.cmd ? html`<div class="lmx-acts" style="margin-top:4px"><code>${st.cmd}</code>${btn('Copy', 'ghost', () => copy(st.cmd))}</div>` : nothing}</div></li>`)}</ol>` : nothing}
    ${steps.length ? html`<div class="lmx-acts"><a class="lm-btn lm-btn--secondary" href=${'#/walk/' + encodeURIComponent(state.space || '') + '/' + encodeURIComponent(b.trail)}>Open the walkthrough</a></div>` : nothing}
    ${w.done_when ? html`<div class="lmx-why"><b>Done when:</b> ${w.done_when}</div>` : nothing}
    ${w.reply ? html`<div class="lmx-acts"><span class="lmx-meta">Message for the agent:</span>${btn('Copy message', 'ghost', () => copy(w.reply))}</div>` : nothing}
    <div class="lmx-acts">${noteBox(`task:${b.trail}`, 'Note, or why you can’t do it')}${btn('Comments and actions','ghost',()=>{location.hash='#/discussion/task/'+encodeURIComponent(b.trail);})}${btn('Done', 'primary', (e) => doTask(e, 'done', b.trail))}${btn('Can’t do', 'danger', (e) => doTask(e, 'cant_do', b.trail))}</div></article>`;
}
export function copy(text) { navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it.', true)); }

/** A decision: the exact action, Approve / Reject / Defer. `select` adds a batch checkbox. */
export function askCard(a, { select } = {}) {
  const p = a.payload || {};
  const approvalProblem = decisionProblem(a, 'approve') || (!a.ask_digest ? 'Reload to verify the action version.' : null);
  const rev = p.reversible === true ? 'Yes' : p.reversible === false ? 'No' : 'Not stated (treated as no)';
  return html`<section class="lm-approval" aria-label="Decision" data-key=${'decision:' + a.trail}>
    <div class="lm-approval-head">${select ? html`<input type="checkbox" .checked=${select.checked} @change=${(e) => select.onChange(a, e.target.checked)} aria-label="Select for a batch answer">` : nothing}${icon('decisions')}<strong>${agentName(a.by)} asks: ${a.summary}</strong><span style="margin-left:auto">${a.deferred ? decision('deferred') : decision('pending')}</span></div>
    <div class="lm-approval-body"><div class="lmx-proposal-head"><div class="lm-eyebrow">Exact proposed action</div>${btn('Copy proposed text', 'ghost', () => copy(p.action || ''))}</div><pre class="lm-action">${p.action || '(not given)'}</pre>
      <p class="lmx-meta">${approvalProblem || 'Approval permits this action. Completion needs separate evidence.'}</p><details><summary>Request details and source</summary><dl class="lm-kv"><dt>Where</dt><dd>${a.where}</dd><dt>Asked</dt><dd>${ago(a.ts)} via ${a.via || ''}</dd><dt>Reversible</dt><dd>${rev}</dd>${a.to ? html`<dt>For</dt><dd>${agentName(a.to)}</dd>` : nothing}<dt>trail</dt><dd><button type="button" class="lmx-idchip" title=${'Copy ' + a.trail} @click=${() => copy(a.trail)}>trail:…${String(a.trail).slice(-8)}</button></dd>
      ${a.deferred ? html`<dt>Deferred</dt><dd>${ago(a.deferred.at)} by ${agentName(a.deferred.by)}${a.deferred.note ? ': ' + a.deferred.note : ''} (still open, original age retained)</dd>` : nothing}</dl></details></div>
    <div class="lm-approval-foot"><input class="lm-input" data-note-for=${'ask:' + a.trail} maxlength="1000" autocomplete="off" placeholder="Note, required when requesting changes" aria-label="Note for the agent" style="flex:1 1 220px;width:auto">
      ${btn('Comments','ghost',()=>{location.hash='#/discussion/decision/'+encodeURIComponent(a.trail);})}${btn('Approve', 'primary', (e) => decide(e, a, 'approve'), {disabled:!!approvalProblem})}${btn('Request changes', 'danger', (e) => decide(e, a, 'reject'))}${btn('Decide later', 'secondary', (e) => decide(e, a, 'defer'))}</div></section>`;
}
/** A "looks done?" suggestion from the reconciler: the evidence, then Close it or Still open. */
export function suggestionCard(i) {
  return html`<article class="lmx-card" data-key=${'suggestion:' + i.job}>
    <div class="lmx-meta">Looks done? · ${[i.plan, i.job].filter(Boolean).join(' › ')}</div><h3>${jobLink(i.job, i.summary)}</h3>
    <div class="lmx-why">${i.evidence}</div>
    <div class="lmx-meta">${joinDot([i.owner ? 'owner ' + agentName(i.owner) : '', i.created_at ? 'checked ' + ago(i.created_at) : ''])}</div>
    <div class="lmx-acts">${noteBox(`confirm-done:${i.job}`, 'Note (optional)')}${btn('Close it', 'primary', (e) => doWork(e, 'confirm-done', i.job))}${btn('Still open', 'secondary', (e) => doWork(e, 'keep-open', i.job))}</div></article>`;
}
export function needItem(i, opts) {
  if (i.type === 'suggestion') return suggestionCard(i);
  return i.type === 'task' ? taskCard(i) : html`<div data-key=${'decision:' + i.trail}><div class="lmx-meta" style="margin:0 0 4px">Decision · ${[i.plan, i.job].filter(Boolean).join(' › ')}</div>${askCard(i.ask, opts)}</div>`;
}

// ─── jobs board, plan rows, agent cards ─────────────────────────────
export function boardCard(j, route) {
  return html`<article class="lmx-card ${glow(route, 'job:' + j.id)}" tabindex="0" data-key=${'job:' + j.id} data-w=${j.stage === 'blocked' ? (j.blocked_on ? j.blocked_on.type : 'none') : nothing}>
    <h3>${jobLink(j.id, j.title)}</h3>
    <div class="lmx-meta">${joinDot([[j.plan, j.track].filter(Boolean).join(' › '), j.owner ? agentName(j.owner) : '', dueTag(j.due, j.stage)])} ${staleTag(j.id)}</div>
    ${j.stage === 'blocked' ? html`<div class="lmx-why">${j.blocked_on ? html`${waitsTag(j.blocked_on)} ${j.blocked_on.note}` : html`<span class="lmx-flag">No reason given</span>`}</div>`
      : j.last ? html`<div class="lmx-why">${j.last.summary} <span class="subtle">${ago(j.last.ts)}</span></div>` : nothing}</article>`;
}
export function planRow(i) {
  return html`<div class="lmx-prow" data-key=${'job:' + i.id}>${jobLink(i.id, i.title)}<span>${stage(i.stage)}</span>
    <span class="lmx-meta">${joinDot([i.owner ? agentName(i.owner) : '', dueTag(i.due, i.stage)])} ${staleTag(i.id)}</span>
    <span>${i.stage === 'blocked' ? (i.blocked_on ? waitsTag(i.blocked_on) : html`<span class="lmx-flag">No reason</span>`) : nothing}</span></div>`;
}
export function agentCard(a, opts = {}) {
  const now = a.now || {}, r = a.recap, job = jobName(now.job), open = opts.open === true;
  const parts = shortenIds(now.doing || '');
  const idChip = (p) => html`<button type="button" class="lmx-idchip" title=${'Copy ' + p.full} @click=${() => copy(p.full)}>trail:${p.chip}</button>`;
  const pulse = a.seen?.state === 'active';
  return html`<article class="lmx-card lmx-agent-card" tabindex="0" data-key=${'agent:' + a.id} data-state=${a.seen?.state || 'unknown'}>
    <div class="lmx-agent-head"><span class="lmx-avatar" aria-hidden="true">${initials(a.id)}</span><a href=${`#/agent/${encodeURIComponent(a.id)}`} class="lmx-agent-id">${a.id}</a><span class="lmx-agent-seen">${pulse ? html`<i class="lmx-pulse" aria-hidden="true"></i>` : nothing}${seenTag(a.seen)}</span></div>
    <div class="lmx-agent-body">
      <div class="lmx-agent-now"><span class="lmx-label">NOW</span>${now.doing ? html`<p class=${'lmx-clamp3' + (open ? ' is-open' : '')}>${parts.map((p) => (p.chip ? idChip(p) : p.text))}</p>${now.doing.length > 140 ? html`<button type="button" class="lmx-linkish" aria-expanded=${String(open)} @click=${opts.toggle}>${open ? 'Show less' : 'Show more'}</button>` : nothing}` : html`<span class="lmx-flag">No Now set</span>`}</div>
      ${job || now.next ? html`<div class="lmx-nextbox"><span class="lmx-label">NEXT UP</span>${job ? html`<a class="lmx-jobchip" href=${'#/job/' + encodeURIComponent(job)}>${job}</a>` : nothing}${now.next ? html`<p class="lmx-clamp2">${now.next}</p>` : nothing}</div>` : nothing}
      ${r ? html`<details class="lmx-recap"><summary>Last recap · ${ago(r.ended_at)}</summary><p>${r.summary}</p></details>` : nothing}
    </div>
    <div class="lmx-agent-foot"><span class="lmx-checkpill" data-ok=${now.doing ? '1' : '0'}>Now ${now.doing ? '✓' : '✗'}</span><span class="lmx-checkpill" data-ok=${r ? '1' : '0'}>Recap ${r ? '✓' : '✗'}</span>${agentDispatchButton(agentDispatchPrompt(a, opts.space || state.space))}</div></article>`;
}

// ─── lanes ───────────────────────────────────────────────────────────
function laneActs(l) {
  const st = l.lane ? l.lane.status : null;
  return html`<div class="lmx-acts">
    ${!st && l.id !== 'general' ? btn('Make active', 'secondary', (e) => doLane(e, l.id, 'active')) : nothing}
    ${st !== 'p0' ? btn('Make P0', 'secondary', (e) => doLane(e, l.id, 'p0')) : nothing}
    ${st === 'parked' ? btn('Unpark', 'primary', (e) => doLane(e, l.id, 'active')) : nothing}
    ${st !== 'parked' && l.id !== 'general' ? html`${noteBox(`lane:${l.id}`, 'Why park it')}${btn('Park', 'secondary', (e) => doLane(e, l.id, 'parked'))}` : nothing}</div>`;
}
const laneJobRow = (j) => html`<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto" data-key=${'job:' + j.id}>${jobLink(j.id, j.title)}<span class="lmx-meta">${agentName(j.owner || '')}${j.since ? ' · ' + ago(j.since) : ''}</span></div>`;
const parkedRow = (j) => { const b = j.blocked_on || {}; return html`<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto" data-key=${'job:' + j.id}><div>${jobLink(j.id, j.title)}<div class="lmx-meta">${b.note || ''}</div></div><span class="lmx-meta">${joinDot([b.until ? 'until ' + b.until : '', j.owner ? agentName(j.owner) : ''])}</span></div>`; };
export function laneCard(l, big, route) {
  const ln = l.lane || {};
  return html`<section class="lmx-card lmx-lanecard ${glow(route, 'lane:' + l.id)}" data-key=${'lane:' + l.id} data-l=${ln.status || 'none'}>
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap"><h3 style=${big ? 'font-size:20px' : ''}>${laneBadge(ln)}<a href=${`#/plan/${encodeURIComponent(l.id)}`} style="color:inherit;text-decoration:none">${l.title}</a></h3><span class="lmx-pct">${num(l.percent)}%</span></div>
    <div class="lmx-bar"><i style=${`width:${num(l.percent)}%`}></i></div>
    <div class="lmx-meta">${joinDot([ln.owner ? 'driven by ' + ln.owner : '', `${num(l.done)} of ${num(l.jobs)} done`, l.active_count ? `${num(l.active_count)} active` : '', l.blocked_count ? html`<b style="color:var(--warning)">${num(l.blocked_count)} blocked</b>` : '', l.parked_jobs.length ? `${l.parked_jobs.length} parked` : ''])}</div>
    ${ln.status === 'parked' ? html`<div class="lmx-why"><b>Parked:</b> ${ln.why || ''}${ln.until ? html` <b>Until:</b> ${ln.until}` : nothing}</div>` : ln.why ? html`<div class="lmx-why">${ln.why}</div>` : nothing}
    ${l.next_milestone ? html`<div class="lmx-why">Next: ${l.next_milestone.title}${l.next_milestone.date ? ' · ' + l.next_milestone.date : ''}</div>` : nothing}
    ${big && l.active.length ? html`<div class="lmx-colhead" style="margin:8px 0 2px">Moving now</div>${l.active.map(laneJobRow)}` : nothing}
    ${l.parked_jobs.length && ln.status !== 'parked' ? html`<details ?open=${big}><summary class="lmx-meta" style="cursor:pointer;margin-top:6px">Parked inside this lane (${l.parked_jobs.length})</summary>${l.parked_jobs.map(parkedRow)}</details>` : nothing}
    ${laneActs(l)}</section>`;
}
export { jobLink, openJob };
