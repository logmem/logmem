// brief-view.js: display parts for the Brief (home) screen. Pure lit-html templates; the rules live in brief-model.js.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { agentName } from './core.js';
import { agent, textWithIds, emptyState } from './ui.js';
import { splitHeadline } from './dashboard-model.js';
import { needsParts, topNeed, briefTiles, presence, updatedLabel, relTime, fullTime, clock24, dueChip, placeLink } from './brief-model.js';
import { attentionKind } from './dashboard-model.js';

const ACTION = { decision: 'Review decision', task: 'Review task', review: 'Review evidence' };

/** Compact page header: title first (matching nav label), subtitle below. */
export const pageHeader = (subtitle, title, right) => html`<header class="lmx-pageheader lm-page-header"><div class="lm-page-header-main"><h1>${title}</h1>${subtitle ? html`<p class="lm-page-header-sub">${subtitle}</p>` : nothing}</div>${right || nothing}</header>`;

/** The promise strip: the parts always add up to the total, and one action for the top item. */
export function promiseStrip({ needs = [], review }) {
  const p = needsParts(needs), top = topNeed(needs);
  const chip = (label, n) => html`<span class="lmx-need-chip" ?data-zero=${n === 0}>${label} <b>${n}</b></span>`;
  return html`<section class="lmx-promise" aria-label="What needs you">
    <div class="lmx-promise-text"><h2>Always know what needs you.</h2>
      <p class="lmx-promise-parts">${chip('Decisions', p.decision)}<span aria-hidden="true">+</span>${chip('Tasks', p.task)}<span aria-hidden="true">+</span>${chip('Reviews', p.review)}<span aria-hidden="true">=</span><span class="lmx-need-total" ?data-zero=${p.total === 0}><b>${p.total}</b> ${p.total === 1 ? 'item needs' : 'items need'} you</span></p>
      ${top ? html`<p class="lmx-promise-top"><span class="lmx-meta">Next:</span> ${splitHeadline(top.summary || top.ask?.summary).head}</p>` : html`<p class="lmx-promise-top lmx-meta">Nothing needs you right now.</p>`}</div>
    ${top ? html`<button type="button" class="lm-btn lm-btn--primary" @click=${() => review(top)}>${ACTION[attentionKind(top)]}</button>` : html`<a class="lm-btn lm-btn--secondary" href="#/queue">Open Inbox</a>`}
  </section>`;
}

/** Four stat tiles. Every tile is a link; a zero is dimmed. */
export function statTiles(input, onNeeds) {
  return html`<nav class="lmx-stat-tiles" aria-label="Workspace numbers">${briefTiles(input).map((t) => html`<a class="lmx-stat-tile" href=${t.href} data-tile=${t.id} data-tone=${t.tone || nothing} ?data-zero=${t.zero} ?data-small=${t.small} @click=${t.id === 'needs' && onNeeds ? (e) => { e.preventDefault(); onNeeds(); } : nothing}><span class="lmx-stat-label">${t.label}</span><strong>${t.value}</strong><span class="lmx-stat-sub">${t.sub}</span></a>`)}</nav>`;
}

/** Agents list: avatar, name, what it is doing, presence, and when it last wrote. */
export function agentsList(agents = [], limit = 8) {
  const shown = agents.slice(0, limit);
  return html`<section class="lmx-brief-panel" aria-labelledby="brief-agents"><div class="lmx-brief-panel-head"><h2 id="brief-agents">Agents</h2><a href="#/agents">View agents</a></div>
    ${shown.length ? html`<ul class="lmx-agent-rows">${shown.map((a) => { const p = presence(a); return html`<li><a href=${'#/agent/' + encodeURIComponent(a.id)} class="lmx-agent-row">${agent(a.id)}<span class="lmx-agent-doing" title=${a.doing || ''}>${a.doing || (a.job ? 'On ' + a.job : 'Nothing recorded')}</span><span class="lm-presence" data-p=${p.state === 'paused' ? 'idle' : p.state}>${p.label}</span><span class="lmx-meta lmx-agent-updated">${updatedLabel(a.seen)}</span></a></li>`; })}</ul>${agents.length > limit ? html`<p class="lmx-meta">${agents.length - limit} more on the Agents page.</p>` : nothing}` : emptyState('No agents yet.', 'Connect an agent and it appears here.')}
  </section>`;
}

/** The oldest open handoff, with who, what and when it is due. */
export function handoffCard(item, now = Date.now()) {
  if (!item) return html`<section class="lmx-brief-panel" aria-labelledby="brief-flight"><div class="lmx-brief-panel-head"><h2 id="brief-flight">Oldest open request</h2><a href="#/queue">Inbox</a></div><p class="lmx-meta">No open handoffs on the first Inbox page.</p></section>`;
  const { head } = splitHeadline(item.summary), due = dueChip(item, now);
  return html`<section class="lmx-brief-panel" aria-labelledby="brief-flight"><div class="lmx-brief-panel-head"><h2 id="brief-flight">Oldest open request</h2><a href="#/queue">Inbox</a></div>
    <a class="lmx-flight" href="#/queue"><span class="lmx-flight-who">${agent(item.from)}<span aria-hidden="true">→</span>${agent(item.to)}</span><strong>${head}</strong><span class="lmx-flight-meta"><span class="lmx-due-chip" data-tone=${due.tone || nothing}>${due.text}</span><span class="lmx-meta" title=${fullTime(item.created_at)}>opened ${relTime(item.created_at, now)}</span></span></a></section>`;
}

/** Recent entries, newest first, with a coloured rule by kind. */
export function recentFeed(entries = [], limit = 6) {
  const list = entries.slice(0, limit);
  return html`<section class="lmx-brief-panel" aria-labelledby="brief-recent"><div class="lmx-brief-panel-head"><h2 id="brief-recent">Recent <span class="lmx-live-dot" aria-hidden="true"></span><span class="lmx-meta">live</span></h2></div>
    ${list.length ? html`<ol class="lmx-feed">${list.map((e) => feedRow(e))}</ol>` : html`<p class="lmx-meta">No recent job updates.</p>`}
    <a class="lmx-text-link" href="#/activity">View all activity →</a></section>`;
}

/** One feed row. Shared by the Brief and the Activity screen. */
export function feedRow(e, { now = Date.now(), timeOnly = false } = {}) {
  const place = placeLink(e.where);
  return html`<li class="lmx-feed-row" data-k=${e.group || 'system'}><time datetime=${Number.isFinite(Number(e.ts)) ? new Date(Number(e.ts)).toISOString() : nothing} title=${fullTime(e.ts)}>${timeOnly ? clock24(e.ts) : relTime(e.ts, now)}</time>
    <div class="lmx-feed-main"><p>${textWithIds(e.summary)}</p><span class="lmx-feed-meta"><span class="lmx-feed-who">${agentName(e.by) || 'unknown'}</span>${place ? html`<a href=${place.href}>${place.label}</a>` : nothing}</span></div></li>`;
}
