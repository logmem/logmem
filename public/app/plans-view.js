// plans-view.js: the Plans page under Work (#/plans, #/plans/<id>). #/lanes and #/plan/<id> stay as aliases.
// Each plan is one row: progress, priority, next milestone, blocked and overdue counts. Opening a plan shows its
// milestones as a vertical timeline with the jobs toward each one. Priority changes use the existing lane API.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { state, agentName } from './core.js';
import { icon, agent, stage, emptyState, laneBadge } from './ui.js';
import { renderView, currentRoute } from './shell.js';
import { load } from './data.js';
import { jobLink } from './cards.js';
import { seedCard } from './seed-components.js';
import { setPlanPriority } from './actions.js';
import { milestoneLabel, WORDS } from './labels.js';
import { planRows, groupPlanRows, priorityMenu, needsReason, milestoneTimeline, waitsOn, isOverdue, todayISO } from './plans-model.js';

const enc = encodeURIComponent;
const planHref = (id) => '#/plans/' + enc(id);
const crumbsFor = (title) => [html`<a href="#/work">Work</a>`, title ? html`<a href="#/plans">Plans</a>` : 'Plans', ...(title ? [title] : [])];
// One open priority menu and one pause form at a time, across redraws of the same page.
const ui = { route: null, pausing: null, saving: null, q: '', status: 'all' };
const reduce = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const focusSoon = (sel) => requestAnimationFrame(() => document.querySelector(sel)?.focus({ preventScroll: reduce() }));
const spaceLabel = () => (state.customer ? state.spaceRecords.find((s) => s.id === state.spaceId)?.name || state.space : state.space);

/** The tabs that tie Plans to Work: List and Board go back to the Work page in that layout. */
export const workTabs = (current) => html`<nav class="lmx-tabsbar lmx-worktabs" aria-label="Work views">
  <a href="#/work/list" aria-current=${current === 'list' ? 'page' : nothing}>${WORDS.list}</a><a href="#/work/board" aria-current=${current === 'board' ? 'page' : nothing}>Board</a><a href="#/plans" aria-current=${current === 'plans' ? 'page' : nothing}>${WORDS.plans}</a></nav>`;

// ─── priority menu and the in-page pause form ───────────────────────
function priorityControl(p, redraw) {
  if (p.general) return nothing;
  const key = 'prio-' + p.id;
  const choose = async (status, ev) => {
    const box = ev.currentTarget.closest('details'); if (box) box.open = false;
    if (needsReason(status)) { ui.pausing = p.id; redraw(); focusSoon(`[data-pause-for="${CSS.escape(p.id)}"] input`); return; }
    ui.saving = p.id; redraw();
    await setPlanPriority({ plan: p.id, title: p.title, status });
    ui.saving = null; redraw();
  };
  const menu = html`<details class="lmx-prio-menu" @keydown=${(e) => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary').focus(); } }}>
    <summary class="lm-btn lm-btn--secondary" aria-label=${'Change priority for ' + p.title} ?aria-disabled=${ui.saving === p.id}>${ui.saving === p.id ? 'Saving…' : 'Priority'}</summary>
    <div class="lmx-prio-list" role="group" aria-label=${'Priority for ' + p.title} id=${key}>
      ${priorityMenu(p.status).map(([status, label]) => html`<button type="button" ?disabled=${ui.saving === p.id} @click=${(e) => choose(status, e)}><span class="lmx-prio" data-l=${status}>${label}</span>${status === 'p0' ? html`<small>Only one plan can be Top priority. The current one moves to Active.</small>` : status === 'parked' ? html`<small>You say why before it pauses.</small>` : nothing}</button>`)}
    </div></details>`;
  if (ui.pausing !== p.id) return menu;
  const cancel = () => { ui.pausing = null; redraw(); focusSoon(`[data-key="plan:${CSS.escape(p.id)}"] .lmx-prio-menu summary`); };
  const submit = async (e) => {
    e.preventDefault();
    const why = e.currentTarget.why.value.trim();
    if (!why) { e.currentTarget.why.focus(); return; }
    ui.saving = p.id; redraw();
    const done = await setPlanPriority({ plan: p.id, title: p.title, status: 'parked', why });
    ui.saving = null; if (done) ui.pausing = null; redraw();
  };
  return html`<form class="lmx-pause-form" data-pause-for=${p.id} @submit=${submit} @keydown=${(e) => { if (e.key === 'Escape') cancel(); }}>
    <label class="lm-field"><span class="lm-label">Why pause ${p.title}?</span><input class="lm-input" name="why" required maxlength="300" autocomplete="off" placeholder="One line, for example: waiting on the sponsor"></label>
    <div class="lmx-pause-acts"><button class="lm-btn lm-btn--primary" ?disabled=${ui.saving === p.id}>${ui.saving === p.id ? 'Saving…' : 'Pause plan'}</button><button type="button" class="lm-btn lm-btn--ghost" @click=${cancel}>Cancel</button></div></form>`;
}

const progress = (done, total, percent, label) => html`<div class="lm-plan-prog lmx-planprog">
  <div class="lm-plan-prog-top">
    <span class="lmx-meta">${done} of ${total} ${total === 1 ? 'job' : 'jobs'} done</span>
    <span class="lm-plan-pct mono">${percent}%</span>
  </div>
  <span class="lmx-planbar" role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}><i style=${'width:' + percent + '%'}></i></span>
</div>`;
const countChip = (n, word, tone) => html`<span class="lmx-countchip" data-tone=${tone} ?data-zero=${!n}><b>${n}</b> ${word}</span>`;

// ─── the list ────────────────────────────────────────────────────────
function planRow(p, redraw, overdueKnown) {
  return html`<article class="lm-plan-card lmx-planrow" data-key=${'plan:' + p.id} data-l=${p.status || 'none'}>
    <div class="lm-plan-card-main">
      <div class="lmx-planrow-name">
        <h3><a href=${planHref(p.id)}>${p.title}</a></h3>
        ${p.general ? html`<span class="lmx-meta">Jobs not filed in a plan</span>` : laneBadge({ status: p.status }, true)}
      </div>
      <div class="lmx-planrow-next">
        ${p.next ? html`<span class="lm-plan-ms"><span class="lmx-meta">Next milestone:</span> <strong>${p.next.title}</strong>${p.next.date ? html` <span class="lmx-meta mono">${p.next.date}</span>` : nothing}</span>` : html`<span class="lmx-meta">No milestone set</span>`}
        ${p.status === 'parked' && p.why ? html`<span class="lmx-meta">Paused: ${p.why}${p.until ? ' · until ' + p.until : ''}</span>` : nothing}
      </div>
    </div>
    <div class="lm-plan-card-prog">${progress(p.done, p.total, p.percent, p.title + ' progress')}</div>
    <div class="lmx-planrow-counts">${countChip(p.blocked, 'blocked', 'warning')}${overdueKnown ? countChip(p.overdue, 'overdue', 'danger') : nothing}</div>
    <div class="lmx-planrow-act"><a class="lm-btn lm-btn--ghost" style="text-decoration:none" href=${planHref(p.id)}>Open →</a>${priorityControl(p, redraw)}</div>
  </article>`;
}

const skeleton = (n) => html`<div class="lmx-planlist" aria-busy="true" aria-label="Loading plans">${Array.from({ length: n }, () => html`<div class="lmx-planrow lmx-skel" aria-hidden="true"><i></i><i></i><i></i></div>`)}<p class="lmx-meta">Loading plans…</p></div>`;

async function plansList() {
  if (currentRoute() !== 'plans') renderView('plans', crumbsFor(), html`${workTabs('plans')}${skeleton(3)}`);
  const [d, jobs] = await Promise.all([load('lanes'), load('jobs')]);
  if (!okHook(d)) return;
  const jobsOk = jobs && jobs.__status === 200 && Array.isArray(jobs.jobs);
  const rows = planRows(d.lanes || [], jobsOk ? jobs.jobs : []);
  const draw = () => {
    if (!rows.length) return renderView('plans', crumbsFor(), html`${workTabs('plans')}${emptyState('No plans yet.', 'Agents put jobs in a plan with logmem_assign and details.plan. Each plan appears here with its milestones.')}${seedCard({ project: spaceLabel() })}`);
    const totalBlocked = rows.reduce((s, r) => s + (r.blocked || 0), 0);
    const totalOverdue = rows.reduce((s, r) => s + (r.overdue || 0), 0);
    const topPlans = rows.filter((r) => r.status === 'p0');
    const q = ui.q.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (ui.status !== 'all') {
        const key = r.status || 'none';
        if (key !== ui.status) return false;
      }
      if (!q) return true;
      return [r.title, r.id, r.next?.title, r.why].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    const groups = groupPlanRows(filtered);
    const filterModes = [
      ['all', 'All', rows.length],
      ['p0', 'Top priority', rows.filter((r) => r.status === 'p0').length],
      ['active', 'Active', rows.filter((r) => r.status === 'active').length],
      ['parked', 'Paused', rows.filter((r) => r.status === 'parked').length],
    ].filter(([k, , c]) => k === 'all' || c > 0);
    const hasFilter = ui.status !== 'all' || Boolean(q);

    renderView('plans', crumbsFor(), html`${workTabs('plans')}
      <header class="lmx-pageheader">
        <div>
          <span class="lm-eyebrow">Work · ${rows.length} ${rows.length === 1 ? 'plan' : 'plans'}</span>
          <h1>Plans</h1>
        </div>
        <div class="lmx-pageheader-links">
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/work">Work board</a>
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/queue">Inbox</a>
        </div>
      </header>

      <section class="lm-kpi-strip" aria-label="Plan summary">
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Plans</span><span class="lm-kpi-val">${rows.length}</span><span class="lm-kpi-sub">tracked in space</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Top priority</span><span class="lm-kpi-val">${topPlans.length ? topPlans[0].title : 'None'}</span><span class="lm-kpi-sub">${topPlans.length ? `${topPlans[0].percent}% complete` : 'pick via Priority'}</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Blocked jobs</span><span class="lm-kpi-val">${totalBlocked}</span><span class="lm-kpi-sub">across all plans</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Overdue jobs</span><span class="lm-kpi-val">${jobsOk ? totalOverdue : '—'}</span><span class="lm-kpi-sub">${jobsOk ? 'past due date' : 'work list unavailable'}</span></div>
      </section>

      ${topPlans.length ? nothing : html`<div class="lm-alert lm-alert--info">${icon('alert')}<div>No plan is Top priority. Open a plan's Priority menu to pick one.</div></div>`}

      <div class="lm-ftbar" role="region" aria-label="Filter plans">
        <div class="lm-ftbar-pills" role="group" aria-label="Priority filter">
          ${filterModes.map(([k, lbl, c]) => html`<button type="button" class="lm-ftbar-pill" aria-pressed=${String(ui.status === k)} @click=${() => { ui.status = k; draw(); }}>${lbl} <span>${c}</span></button>`)}
        </div>
        <div class="lm-ftbar-right">
          <label class="lmx-chat-sr" for="plans-search">Search plans</label>
          <input id="plans-search" type="search" class="lm-ftbar-search" placeholder="Search plans or milestones…" .value=${ui.q} @input=${(e) => { ui.q = e.currentTarget.value; draw(); }}>
          ${hasFilter ? html`<button type="button" class="lm-ftbar-clear" @click=${() => { ui.q = ''; ui.status = 'all'; draw(); }}>Clear</button>` : nothing}
        </div>
      </div>

      ${filtered.length
        ? groups.filter((g) => g.rows.length).map((g) => html`<section class="lmx-plangroup" aria-labelledby=${'pg-' + (g.status || 'none')}><h2 class="lmx-section-title" id=${'pg-' + (g.status || 'none')}>${g.label} <span>${g.rows.length}</span></h2>
          <div class="lmx-planlist">${repeat(g.rows, (p) => p.id, (p) => planRow(p, draw, jobsOk))}</div></section>`)
        : emptyState('No plans match these filters.', 'Clear the search or pick All priorities.')}
      <p class="lmx-meta">${jobsOk ? 'Overdue counts jobs past their due date that are not done.' : 'Overdue counts are unavailable because the work list did not load.'}</p>`);
  };
  draw();
}

// ─── one plan ────────────────────────────────────────────────────────
const ORDER = { blocked: 0, active: 1, open: 2, done: 3 };
const byStage = (a, b) => (ORDER[a.stage] ?? 2) - (ORDER[b.stage] ?? 2) || String(a.title).localeCompare(String(b.title));
function jobRow(j, today) {
  const wait = waitsOn(j, agentName), late = isOverdue(j, today);
  return html`<li class="lm-plan-job lmx-tljob" data-stage=${j.stage}>
    <span class="lmx-tljob-owner">${j.owner ? agent(j.owner) : html`<span class="lmx-meta">No owner</span>`}</span>
    <span class="lmx-tljob-title">${jobLink(j.id, j.title)}${wait ? html`<span class="lmx-meta lmx-tljob-wait">${wait}</span>` : nothing}</span>
    <span class="lmx-tljob-state">${stage(j.stage)}${late ? html`<span class="lmx-flag">Overdue · ${j.due}</span>` : j.due && j.stage !== 'done' ? html`<span class="lmx-meta mono">due ${j.due}</span>` : nothing}</span></li>`;
}
const jobList = (jobs, today) => (jobs.length ? html`<ul class="lmx-tljobs">${repeat([...jobs].sort(byStage), (j) => j.id, (j) => jobRow(j, today))}</ul>` : html`<p class="lmx-meta">No jobs count toward this milestone yet.</p>`);
const dayText = (n) => (n == null ? 'No date' : n === 0 ? 'Today' : n > 0 ? `In ${n} ${n === 1 ? 'day' : 'days'}` : `${-n} ${n === -1 ? 'day' : 'days'} ago`);

async function planDetail(id) {
  if (currentRoute() !== 'plans') renderView('plans', crumbsFor(id), skeleton(2));
  const d = await load('plan', { id });
  if (!okHook(d)) return;
  if (!d.plan || d.plan !== id) return renderView('plans', crumbsFor(id), html`${emptyState('This plan was not found.', 'It may have been renamed, or it has no jobs yet.')}<p><a href="#/plans">Back to Plans</a></p>`);
  const today = todayISO();
  const items = (d.tracks || []).flatMap((t) => t.items || []);
  const done = items.filter((i) => i.stage === 'done').length, blocked = items.filter((i) => i.stage === 'blocked' && !i.blocked_on?.parked).length, overdue = items.filter((i) => isOverdue(i, today)).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;
  const { steps, loose } = milestoneTimeline(d.milestones || [], items, today);
  const p = { id: d.plan, title: d.title || d.plan, status: d.lane?.status && ['p0', 'active', 'parked'].includes(d.lane.status) ? d.lane.status : null, general: d.plan === 'general' };
  const draw = () => renderView('plans', crumbsFor(p.title), html`${workTabs('plans')}
    <section class="lm-plan-hero lmx-plansum" data-key=${'plan:' + p.id} data-l=${p.status || 'none'}>
      <div class="lm-plan-hero-head">
        <div>
          <div class="lm-plan-hero-badges">
            <a class="lmx-meta" href="#/plans" style="text-decoration:none">← All plans</a>
            ${laneBadge({ status: p.status }, !p.general)}
          </div>
          <h1 class="lm-plan-hero-title">${p.title}</h1>
          ${d.desc ? html`<p class="lmx-meta" style="margin:6px 0 0">${d.desc}</p>` : nothing}
          ${p.status === 'parked' && d.lane?.why ? html`<p class="lmx-meta" style="margin:4px 0 0">Paused: ${d.lane.why}${d.lane.until ? ' · until ' + d.lane.until : ''}</p>` : nothing}
        </div>
        <div class="lmx-planrow-act">
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href=${'#/discussion/plan/' + enc(p.id)}>Plan comments</a>
          ${priorityControl(p, draw)}
        </div>
      </div>

      <div class="lm-kpi-strip" aria-label="Plan progress metrics">
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Progress</span><span class="lm-kpi-val">${percent}%</span><span class="lm-kpi-sub">${done} of ${items.length} jobs done</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Milestones</span><span class="lm-kpi-val">${steps.length}</span><span class="lm-kpi-sub">${steps.filter((s) => s.status === 'done').length} reached</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Blocked</span><span class="lm-kpi-val">${blocked}</span><span class="lm-kpi-sub">${blocked ? 'needs unblock' : 'all clear'}</span></div>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Overdue</span><span class="lm-kpi-val">${overdue}</span><span class="lm-kpi-sub">${overdue ? 'past due date' : 'on track'}</span></div>
      </div>

      ${progress(done, items.length, percent, p.title + ' progress')}
    </section>

    <section aria-labelledby="tl-head" class="lmx-stack" style="gap:12px">
      <h2 class="lmx-section-title" id="tl-head">Milestones <span>${steps.length}</span></h2>
      ${steps.length ? html`<ol class="lm-plan-tl lmx-timeline">${steps.map((s) => {
        const msPct = s.jobs.length ? Math.round((s.done / s.jobs.length) * 100) : (s.status === 'done' ? 100 : 0);
        return html`<li class="lm-plan-step lmx-tlstep" data-status=${s.status} data-key=${'ms:' + s.milestone.id}>
          <span class="lmx-tlmark" aria-hidden="true"></span>
          <div class="lm-plan-step-card lmx-tlbody">
            <div class="lmx-tlhead">
              <span class="lmx-tldate mono">${s.milestone.date || 'No date'}</span>
              <span class="lmx-meta">${s.status === 'done' ? 'Reached' : dayText(s.days)}</span>
              <span class="lmx-mstatus" data-status=${s.status}>${milestoneLabel(s.status)}</span>
              ${s.jobs.length ? html`<span class="lm-plan-step-pct mono">${s.done}/${s.jobs.length} · ${msPct}%</span>` : nothing}
            </div>
            <h3>${s.milestone.title}</h3>
            ${s.milestone.criteria ? html`<p class="lm-plan-crit lmx-tlcrit"><b>Done when:</b> ${s.milestone.criteria}</p>` : nothing}
            ${jobList(s.jobs, today)}
          </div></li>`;
      })}</ol>`
        : html`<div class="lm-plain-panel"><p class="lmx-meta">This plan has no milestones yet. Agents add one with logmem_assign and details.milestone set to true.</p></div>`}</section>

    <section class="lm-plain-panel lmx-tlloose" aria-labelledby="tl-loose">
      <h2 class="lmx-section-title" id="tl-loose" style="margin:0">${WORDS.notInMilestone} <span>${loose.length}</span></h2>
      ${loose.length ? jobList(loose, today) : html`<p class="lmx-meta">Every job counts toward a milestone.</p>`}
    </section>`);
  draw();
}

let okHook = () => true;
export function setPlansOk(fn) { okHook = fn; }
/** #/plans lists every plan; #/plans/<id> opens one. A pulse redraw keeps an open pause form and its text. */
export function plansPage(id) {
  const key = id || '';
  if (ui.route !== key) { ui.route = key; ui.pausing = null; ui.saving = null; ui.q = ''; ui.status = 'all'; }
  return id ? planDetail(id) : plansList();
}
