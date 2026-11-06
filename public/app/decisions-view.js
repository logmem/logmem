// decisions-view.js — the Decisions page at #/decisions (canvas Decisions board).
// Three sections: Open, Answered, Deferred. It reads the same `decisions` view the Knowledge page uses
// and answers through actions.js decide(), so no new endpoint exists. A field the data lacks is not drawn.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago, agentName } from './core.js';
import { load } from './data.js';
import { icon, btn, decision, emptyState, textWithIds } from './ui.js';
import { decide } from './actions.js';
import { decisionProblem } from './dashboard-model.js';
import { renderView } from './shell.js';

/** Sort the `decisions` view into the three sections. A deferred ask is still waiting, so it is not Open. */
export function splitDecisions(d) {
  const waiting = Array.isArray(d && d.waiting) ? d.waiting : [];
  const decided = Array.isArray(d && d.decided) ? d.decided : [];
  return {
    open: waiting.filter((a) => !a.deferred),
    deferred: waiting.filter((a) => a.deferred),
    answered: decided.filter((r) => r && r.ask),
  };
}

const VERDICT = { approve: ['approved', 'Approved'], reject: ['rejected', 'Changes requested'], defer: ['deferred', 'Deferred'] };
const meta = (parts) => parts.filter(Boolean).join(' · ');

function openCard(a, { allowDefer }) {
  const p = a.payload || {};
  const problem = decisionProblem(a, 'approve') || (!a.ask_digest ? 'Reload to verify the action version.' : null);
  const reversible = p.reversible === true ? 'Reversible' : p.reversible === false ? 'Irreversible' : 'Reversibility not stated';
  return html`<section class="lm-approval lmx-dec-card" aria-label="Decision" data-key=${'decision:' + a.trail}>
    <div class="lmx-dec-head">${icon('decisions')}<strong>${a.summary || 'Untitled decision'}</strong>${a.deferred ? decision('deferred') : decision('pending')}</div>
    <p class="lmx-meta">${meta([a.by ? agentName(a.by) : '', a.ts ? ago(a.ts) : '', reversible])}${a.where ? html` · ${textWithIds(a.where)}` : nothing}</p>
    ${p.action ? html`<details class="lmx-dec-action"><summary>Exact proposed action</summary><pre class="lm-action">${p.action}</pre></details>` : nothing}
    ${a.deferred ? html`<p class="lmx-meta">Deferred ${ago(a.deferred.at)} by ${agentName(a.deferred.by)}${a.deferred.note ? ': ' + a.deferred.note : ''}. Still open with its original age.</p>` : nothing}
    ${problem ? html`<p class="lmx-meta">${problem}</p>` : nothing}
    <div class="lmx-dec-foot"><input class="lm-input" data-note-for=${'ask:' + a.trail} maxlength="1000" autocomplete="off" placeholder="Note, required when requesting changes" aria-label="Note for the agent">
      <div class="lmx-dec-acts">${btn('Approve', 'primary', (e) => decide(e, a, 'approve'), { disabled: !!problem })}${btn('Request changes', 'danger', (e) => decide(e, a, 'reject'))}${allowDefer ? btn('Decide later', 'secondary', (e) => decide(e, a, 'defer')) : nothing}</div></div></section>`;
}

function answeredRow({ ask, answer }) {
  const verdict = answer && answer.payload && answer.payload.verdict;
  const v = VERDICT[verdict];
  const note = answer && answer.payload && answer.payload.note;
  return html`<article class="lmx-card lmx-dec-done" data-key=${'decision:' + ask.trail}>
    <h3>${ask.summary || 'Untitled decision'}</h3>
    <div class="lmx-meta">${meta([ask.by ? 'Asked by ' + agentName(ask.by) : '', answer && answer.by ? 'Answered by ' + agentName(answer.by) : '', answer && answer.ts ? ago(answer.ts) : ''])}</div>
    ${v ? decision(v[0], v[1]) : nothing}
    ${note ? html`<p class="lmx-meta">${note}</p>` : nothing}</article>`;
}

const section = (id, title, count, body) => html`<section class="lmx-dec-section" aria-labelledby=${'dec-' + id}><h2 class="lmx-colhead" id=${'dec-' + id}>${title} <b>${count}</b></h2><div class="lmx-stack">${body}</div></section>`;

export function decisionsPage(d) {
  const { open, deferred, answered } = splitDecisions(d);
  renderView('decisions', ['Decisions'], html`<div class="lmx-decisions">
    <div class="lmx-work-toolbar"><h1>Decisions</h1><a href="#/queue">Inbox</a></div>
    <p class="lmx-meta">When an agent asks, it stops and waits here. Your answer is written to the log. Approval permits the action. Completion needs separate evidence.</p>
    ${section('open', 'Open', open.length, open.length ? open.map((a) => openCard(a, { allowDefer: true })) : emptyState('Nothing is waiting on you.', 'New asks from agents appear here.'))}
    ${section('answered', 'Answered', answered.length, answered.length ? answered.map(answeredRow) : emptyState('No answered decisions yet.', 'Approved and rejected asks appear here.'))}
    ${section('deferred', 'Deferred', deferred.length, deferred.length ? deferred.map((a) => openCard(a, { allowDefer: false })) : emptyState('Nothing is deferred.', 'A deferred ask stays open with its original age.'))}
  </div>`);
}

/** Replace the old #/decisions redirect with this page. main.js calls it once with the shared ok() check. */
export function registerDecisions(pages, ok) {
  pages.decisions = async () => {
    const d = await load('decisions');
    if (!ok(d)) return;
    decisionsPage(d);
  };
  return pages;
}
