// profile-components.js — crisp tabbed Agent Details workspace (21st.dev Card Tabs id: 29314).
// Zero collapsed drawers by default: Overview, Run Trace, Activity & Shifts, Follows & Fields.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago, hhmm } from './core.js';
import { seenTag, entries, emptyState } from './ui.js';
import { initials } from './dashboard-model.js';
import { agentDispatchPrompt } from './dispatch-model.js';
import { agentDispatchButton } from './dispatch-components.js';
import { profileNow, recapParts, followGroups, followCounts, shiftRows, profileTelemetry } from './profile-model.js';
import { agentIcon } from './agent-icons.js';
import { profileTools } from './profile-tools.js';
import { dayGroups } from './brief-model.js';
import { activityTimelineGroup, agentStatusCard, agentTraceCard, buildVanillaAgentTrace } from './ui-21st.js';

const pill = (label, on, click) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(on)} @click=${click}>${label}</button>`;
const SHIFT_FILTERS = [['all', 'All'], ['auto', 'Auto'], ['manual', 'Manual']];
const FOLLOW_FILTERS = [['all', 'All'], ['job', 'Jobs'], ['channel', 'Channels']];

function extraValue(x) {
  if (x.kind === 'text') return html`<dd>${x.text}</dd>`;
  if (x.kind === 'list') return html`<dd><ul class="lmx-prof-sub">${x.rows.map((r) => html`<li>${r}</li>`)}</ul></dd>`;
  return html`<dd><dl class="lmx-prof-sub">${x.rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></dd>`;
}

/** Agent profile. d is the agent view payload. pf holds the filters, redraw repaints. */
export function agentProfile({ d, id, pf, redraw, space }) {
  const now = profileNow(d.now), recap = recapParts(d.recap), tel = profileTelemetry(d);
  const logo = agentIcon(space, id);
  const groups = followGroups(d.follows), fc = followCounts(groups);
  const folMode = FOLLOW_FILTERS.some(([k]) => k === pf.fol) ? pf.fol : 'all';
  const folRows = folMode === 'all' ? [...groups.job, ...groups.channel, ...groups.other] : groups[folMode];
  const shiftMode = SHIFT_FILTERS.some(([k]) => k === pf.shift) ? pf.shift : 'all';
  const shifts = shiftRows(d.shifts, shiftMode, { recap: d.recap, log: d.log });
  const set = (k, v) => () => { pf[k] = v; redraw(); };
  const dispatch = { id, now: d.now, recap: d.recap, seen: d.seen };

  const statusTasks = [
    ...(d.handoffs || []).slice(0, 5).map((h, i) => ({ id: 'h-' + (h.trail || i), label: String(h.summary || 'Pending handoff'), status: 'pending', meta: 'handoff' })),
    ...(now.job ? [{ id: 'job-' + now.job, label: now.doing || now.job, status: now.blocked ? 'pending' : 'running', meta: now.blocked ? 'blocked' : 'active' }] : []),
    ...(recap?.next || []).slice(0, 4).map((n, i) => ({ id: 'next-' + i, label: String(n), status: 'pending', meta: 'next' })),
  ];
  const trace = buildVanillaAgentTrace(id, d.shifts, d.log);
  const tab = ['overview', 'trace', 'activity', 'follows'].includes(pf.tab) ? pf.tab : 'overview';
  const logDays = dayGroups(d.log || [], Date.now());

  return html`<section class="lmx-prof" aria-label=${'Agent profile for ' + id}>
    <header class="lmx-card lmx-prof-head" data-state=${tel.state}>
      <div class="lmx-prof-id">
        <span class="lmx-avatar lmx-prof-avatar" aria-hidden="true">${logo ? html`<img src=${logo.src} alt="">` : initials(id)}</span>
        <div>
          <h2 style="margin:0">${id}</h2>
          ${tel.role ? html`<span class="lmx-meta">${tel.role}</span>` : nothing}
        </div>
        <span class="lm-spacer"></span>
        ${agentDispatchButton(agentDispatchPrompt(dispatch, space))}
      </div>
      <div class="lmx-prof-pills">
        <span class="lmx-prof-seen">${seenTag(d.seen)}</span>
        ${now.blocked ? html`<span class="lm-badge lm-badge--warning">Blocked</span>` : nothing}
        ${now.job ? html`<a class="lmx-jobchip" href=${'#/job/' + encodeURIComponent(now.job)}>${now.job}</a>` : nothing}
        ${now.lane ? html`<span class="lmx-tag">plan · ${now.lane}</span>` : nothing}
        ${now.waiting ? html`<span class="lmx-tag">waiting on · ${now.waiting}</span>` : nothing}
      </div>
      <p class="lmx-meta">Reporting activity from the log, not runtime reachability. ${now.updatedAt ? 'Now updated ' + ago(now.updatedAt) + '.' : ''}</p>
    </header>

    <section class="lm-kpi-strip" aria-label="Agent summary metrics">
      <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Reporting status</span><span class="lm-kpi-val">${d.seen?.label || 'Offline'}</span><span class="lm-kpi-sub">${tel.state}</span></div>
      <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Waiting requests</span><span class="lm-kpi-val">${tel.waiting}</span><span class="lm-kpi-sub">open handoffs</span></div>
      <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Follows</span><span class="lm-kpi-val">${tel.follows}</span><span class="lm-kpi-sub">jobs & channels</span></div>
      <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Recent shifts</span><span class="lm-kpi-val">${tel.shifts}</span><span class="lm-kpi-sub">${(d.log || []).length} log entries</span></div>
    </section>

    <section class="lm-ctabs" aria-label="Agent workspace sections">
      <div class="lm-ctabs-bar">
        <div class="lm-ctabs-list" role="tablist" aria-label="Agent detail views">
          ${[
            ['overview', 'Overview', null],
            ['trace', 'Run Trace', trace.spans.length],
            ['activity', 'Activity & Shifts', (d.log || []).length],
            ['follows', 'Follows & Fields', fc.all + now.extras.length],
          ].map(([k, label, count]) => html`<button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === k)} @click=${set('tab', k)}><span>${label}</span>${count != null ? html`<span class="lm-ctabs-count">${count}</span>` : nothing}</button>`)}
        </div>
        ${profileTools({ d, id, space, redraw })}
      </div>

      <div class="lm-ctabs-panel" role="tabpanel">
        ${tab === 'overview' ? html`
          ${agentStatusCard({
            title: now.doing || 'No active task recorded',
            detail: now.next ? 'Next: ' + now.next : now.job ? 'Active job: ' + now.job : 'Waiting for next shift or assignment.',
            badge: now.blocked ? 'Blocked' : (d.seen?.label || 'status'),
            tasks: statusTasks,
          })}
          <div class="lm-ctabs-grid2">
            <section class="lm-plain-panel" aria-label="Last recap">
              <h3><span>Last recap</span>${recap?.endedAt ? html`<span class="lmx-meta">${ago(recap.endedAt)}</span>` : nothing}</h3>
              ${recap ? html`
                <p>${recap.headline}</p>
                ${recap.rest.map((l) => html`<p class="lmx-meta">${l}</p>`)}
                ${recap.next.length ? html`<ul class="lmx-prof-next">${recap.next.map((n) => html`<li>${n}</li>`)}</ul>` : nothing}
                <div class="lm-prov"><span>${recap.mode}${recap.reason ? ' · ' + recap.reason : ''}</span></div>
              ` : emptyState('No Recap yet.', 'This agent has not finished a shift.')}
            </section>
            <section class="lm-plain-panel" aria-label=${'Requests waiting for ' + id}>
              <h3><span>Waiting for ${id}</span><span class="lmx-meta">${d.handoffs.length}</span></h3>
              ${d.handoffs.length ? entries(d.handoffs) : emptyState('Nothing waiting.', 'Requests show here until accepted or declined.')}
            </section>
          </div>
        ` : nothing}

        ${tab === 'trace' ? (trace.spans.length
          ? agentTraceCard({ trace, pf, redraw })
          : emptyState('No trace entries yet.', 'Shift spans appear here once this agent writes entries.')) : nothing}

        ${tab === 'activity' ? html`
          <section class="lm-plain-panel" aria-label="Recent shifts">
            <h3><span>Recent shifts</span><span class="lmx-meta">${shifts.counts.all}</span></h3>
            ${shifts.counts.all ? html`
              <div class="lmx-filter" role="group" aria-label="Filter shifts">${SHIFT_FILTERS.map(([k, l]) => pill(`${l} (${shifts.counts[k]})`, shiftMode === k, set('shift', k)))}</div>
              <ol class="lmx-prof-timeline">${shifts.rows.map((s) => html`<li><span class="mono">${hhmm(s.ts)}</span><span class="lmx-tag">${s.auto ? 'auto' : 'manual'}</span><span>${s.host}</span><span class="mono lmx-meta">${s.shift}</span>${s.endedBy || s.entries != null ? html`<span class="lmx-shift-end">${s.endedBy ? html`<span class="lmx-tag">Ended by ${s.endedBy}${s.endedAt ? ' ' + hhmm(s.endedAt) : ''}</span>` : nothing}${s.entries != null ? html`<span class="lmx-meta">${s.entries} ${s.entries === 1 ? 'entry' : 'entries'}</span>` : nothing}</span>` : nothing}</li>`)}</ol>
            ` : emptyState('No shifts yet.', 'Shifts appear when this agent calls logmem_start.')}
          </section>
          ${logDays.length ? logDays.map((g) => activityTimelineGroup(g)) : emptyState('No log entries yet.', '')}
        ` : nothing}

        ${tab === 'follows' ? html`
          <div class="lm-ctabs-grid2">
            <section class="lm-plain-panel" aria-label="Follows">
              <h3><span>Follows</span><span class="lmx-meta">${fc.all}</span></h3>
              ${fc.all ? html`
                <div class="lmx-filter" role="group" aria-label="Filter follows">${FOLLOW_FILTERS.map(([k, l]) => pill(`${l} (${fc[k === 'all' ? 'all' : k]})`, folMode === k, set('fol', k)))}</div>
                <div class="lmx-prof-follows">${folRows.map((f) => html`<span class="lmx-prof-follow"><span class="mono">${f.id}</span>${f.role ? html`<span class="lm-badge">${f.role}</span>` : nothing}</span>`)}</div>
              ` : emptyState('Follows nothing.', 'Handoffs and logmem_follow add channels and jobs here.')}
            </section>
            <section class="lm-plain-panel" aria-label="Now fields">
              <h3><span>Now fields</span><span class="lmx-meta">${now.extras.length}</span></h3>
              ${now.extras.length ? html`<dl class="lm-kv lmx-prof-kv">${now.extras.map((x) => html`<dt>${x.key}</dt>${extraValue(x)}`)}</dl>` : html`<span class="lmx-meta">No extra Now fields set.</span>`}
            </section>
          </div>
        ` : nothing}
      </div>
    </section>
  </section>`;
}
