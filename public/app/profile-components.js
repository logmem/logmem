// profile-components.js — the agent profile page as a header, a tile grid and four drawers.
// Pass state in, get a template back. Pickers call redraw(), so the host page owns the render.
// Values reach the page only as text nodes or attribute values, never as HTML.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago, hhmm } from './core.js';
import { seenTag, entries, emptyState } from './ui.js';
import { initials } from './dashboard-model.js';
import { agentDispatchPrompt } from './dispatch-model.js';
import { agentDispatchButton } from './dispatch-components.js';
import { profileNow, recapParts, followGroups, followCounts, FOLLOW_SHOW, shiftRows, profileTelemetry } from './profile-model.js';

const pill = (label, on, click) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(on)} @click=${click}>${label}</button>`;
const SHIFT_FILTERS = [['all', 'All'], ['auto', 'Auto'], ['manual', 'Manual']];
const FOLLOW_FILTERS = [['all', 'All'], ['job', 'Jobs'], ['channel', 'Channels']];
const countTag = (n, one, many) => html`<span class="lmx-tag">${n} ${n === 1 ? one : many}</span>`;

function extraValue(x) {
  if (x.kind === 'text') return html`<dd>${x.text}</dd>`;
  if (x.kind === 'list') return html`<dd><ul class="lmx-prof-sub">${x.rows.map(r => html`<li>${r}</li>`)}</ul></dd>`;
  return html`<dd><dl class="lmx-prof-sub">${x.rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></dd>`;
}

/** Agent profile. d is the agent view payload. pf holds the filters, redraw repaints. */
export function agentProfile({ d, id, pf, redraw, space }) {
  const now = profileNow(d.now), recap = recapParts(d.recap), tel = profileTelemetry(d);
  const groups = followGroups(d.follows), fc = followCounts(groups);
  const folMode = FOLLOW_FILTERS.some(([k]) => k === pf.fol) ? pf.fol : 'all';
  const folRows = (folMode === 'all' ? [...groups.job, ...groups.channel, ...groups.other] : groups[folMode]);
  const folShown = pf.folAll ? folRows : folRows.slice(0, FOLLOW_SHOW);
  const shiftMode = SHIFT_FILTERS.some(([k]) => k === pf.shift) ? pf.shift : 'all', shifts = shiftRows(d.shifts, shiftMode);
  const set = (k, v) => () => { pf[k] = v; redraw(); };
  const open = k => pf.open?.[k] === true;
  const drawer = (k, title, count, body) => html`<details class="lmx-prof-drawer" ?open=${open(k)} @toggle=${e => { (pf.open = pf.open || {})[k] = e.currentTarget.open; }}><summary><span>${title}</span>${count == null ? nothing : html`<span class="lmx-tag">${count}</span>`}</summary><div class="lmx-prof-drawerbody">${body}</div></details>`;
  const dispatch = { id, now: d.now, recap: d.recap, seen: d.seen };
  return html`<section class="lmx-prof" aria-label=${'Agent profile for ' + id}>
    <header class="lmx-card lmx-prof-head" data-state=${tel.state}>
      <div class="lmx-prof-id"><span class="lmx-avatar" aria-hidden="true">${initials(id)}</span><h2>${id}</h2>${tel.role ? html`<span class="lmx-tag">${tel.role}</span>` : nothing}</div>
      <div class="lmx-prof-pills">
        <span class="lmx-prof-seen">${seenTag(d.seen)}</span>
        ${now.blocked ? html`<span class="lm-badge lm-badge--warning">Blocked</span>` : nothing}
        ${countTag(tel.waiting, 'handoff waiting', 'handoffs waiting')}${countTag(tel.follows, 'follow', 'follows')}${countTag(tel.shifts, 'recent shift', 'recent shifts')}
      </div>
      <p class="lmx-meta">These are reports from the log. Recent activity does not prove a running process. Schedule coverage and run controls are not verified.</p>
    </header>

    <div class="lmx-prof-grid">
      <section class="lmx-card lmx-prof-tile lmx-prof-now" aria-label="Now">
        <span class="lmx-label">NOW</span>
        ${now.doing ? html`<p class=${'lmx-clamp3' + (pf.moreNow ? ' is-open' : '')}>${now.doing}</p>${now.doing.length > 140 ? html`<button type="button" class="lmx-linkish" aria-expanded=${String(!!pf.moreNow)} @click=${set('moreNow', !pf.moreNow)}>${pf.moreNow ? 'Show less' : 'Show more'}</button>` : nothing}` : html`<span class="lmx-flag">No Now set</span>`}
        <div class="lmx-prof-facts">
          ${now.job ? html`<a class="lmx-jobchip" href=${'#/job/' + encodeURIComponent(now.job)}>${now.job}</a>` : nothing}
          ${now.lane ? html`<span class="lmx-tag">lane · ${now.lane}</span>` : nothing}
          ${now.waiting ? html`<span class="lmx-tag">waiting on · ${now.waiting}</span>` : nothing}
          ${now.blockedNote ? html`<span class="lmx-tag" data-late="true">blocked · ${now.blockedNote}</span>` : nothing}
        </div>
      </section>

      <section class="lmx-card lmx-prof-tile" aria-label="Next up">
        <span class="lmx-label">NEXT UP</span>
        ${now.next ? html`<p class="lmx-clamp3">${now.next}</p>` : html`<span class="lmx-meta">No next step recorded.</span>`}
        ${recap?.next.length ? html`<ul class="lmx-prof-next">${recap.next.map(n => html`<li>${n}</li>`)}</ul>` : nothing}
      </section>

      <section class="lmx-card lmx-prof-tile" aria-label="Last recap">
        <span class="lmx-label">LAST RECAP${recap?.endedAt ? html` · <span class="lmx-meta">${ago(recap.endedAt)}</span>` : nothing}</span>
        ${recap ? html`<p>${recap.headline}</p>${recap.rest.length ? html`<details class="lmx-recap-box"><summary><span class="lmx-recap-label">Full recap</span></summary><div class="lmx-recap-scroll">${recap.rest.map(l => html`<p>${l}</p>`)}</div></details>` : nothing}<div class="lm-prov"><span>${recap.mode}${recap.reason ? ' · ' + recap.reason : ''}</span></div>` : emptyState('No Recap yet.', 'This agent has not finished a shift.')}
      </section>

      <section class="lmx-card lmx-prof-tile" aria-label=${'Handoffs waiting for ' + id}>
        <span class="lmx-label">WAITING FOR ${id.toUpperCase()}</span>
        ${d.handoffs.length ? entries(d.handoffs) : emptyState('Nothing waiting.', 'Handoffs show here until the agent accepts or declines them.')}
      </section>
    </div>

    <div class="lmx-prof-drawers">
      ${drawer('fields', 'Now fields', now.extras.length, now.extras.length ? html`<dl class="lm-kv lmx-prof-kv">${now.extras.map(x => html`<dt>${x.key}</dt>${extraValue(x)}`)}</dl>` : html`<span class="lmx-meta">No other fields set.</span>`)}
      ${drawer('follows', 'Follows', fc.all, fc.all ? html`<div class="lmx-filter" role="group" aria-label="Filter follows">${FOLLOW_FILTERS.map(([k, l]) => pill(`${l} (${fc[k === 'all' ? 'all' : k]})`, folMode === k, () => { pf.fol = k; pf.folAll = false; redraw(); }))}</div>
        <div class="lmx-prof-follows">${folShown.map(f => html`<span class="lmx-prof-follow"><span class="mono">${f.id}</span>${f.role ? html`<span class="lm-badge">${f.role}</span>` : nothing}</span>`)}</div>
        ${folRows.length > FOLLOW_SHOW ? html`<button type="button" class="lmx-linkish" aria-expanded=${String(!!pf.folAll)} @click=${set('folAll', !pf.folAll)}>${pf.folAll ? 'Show fewer' : `Show ${folRows.length - FOLLOW_SHOW} more`}</button>` : nothing}` : emptyState('Follows nothing.', 'Handoffs and logmem_follow add channels and jobs here.'))}
      ${drawer('shifts', 'Recent shifts', shifts.counts.all, shifts.counts.all ? html`<div class="lmx-filter" role="group" aria-label="Filter shifts">${SHIFT_FILTERS.map(([k, l]) => pill(`${l} (${shifts.counts[k]})`, shiftMode === k, set('shift', k)))}</div>
        <ol class="lmx-prof-timeline">${shifts.rows.map(s => html`<li><span class="mono">${hhmm(s.ts)}</span><span class="lmx-tag">${s.auto ? 'auto' : 'manual'}</span><span>${s.host}</span><span class="mono lmx-meta">${s.shift}</span></li>`)}</ol>${shifts.rows.length ? nothing : html`<p class="lmx-meta">No shifts match this filter.</p>`}` : emptyState('No shifts.', ''))}
      ${drawer('log', 'Log', d.log.length, entries(d.log))}
    </div>

    <footer class="lmx-prof-foot"><span class="lmx-meta">${now.updatedAt ? 'Now updated ' + ago(now.updatedAt) : 'Now has no update time'}</span><span class="lmx-foot-spacer"></span>${agentDispatchButton(agentDispatchPrompt(dispatch, space))}</footer>
  </section>`;
}
