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
const ui = { route: null, pausing: null, saving: null };
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

const progress = (done, total, percent, label) => html`<div class="lmx-planprog"><span class="lmx-planbar" role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}><i style=${'width:' + percent + '%'}></i></span><span class="lmx-meta">${done} of ${total} ${total === 1 ? 'job' : 'jobs'} done</span></div>`;
const countChip = (n, word, tone) => html`<span class="lmx-countchip" data-tone=${tone} ?data-zero=${!n}><b>${n}</b> ${word}</span>`;

// ─── the list ────────────────────────────────────────────────────────
function planRow(p, redraw, overdueKnown) {
  return html`<article class="lmx-planrow" data-key=${'plan:' + p.id} data-l=${p.status || 'none'}>
    <div class="lmx-planrow-name"><h3><a href=${planHref(p.id)}>${p.title}</a></h3>${p.general ? html`<span class="lmx-meta">Jobs not filed in a plan</span>` : laneBadge({ status: p.status }, true)}</div>
    ${progress(p.done, p.total, p.percent, p.title + ' progress')}
    <div class="lmx-planrow-next">${p.next ? html`<span class="lmx-meta">Next milestone</span><span>${p.next.title}${p.next.date ? html` <span class="lmx-meta mono">${p.next.date}</span>` : nothing}</span>` : html`<span class="lmx-meta">No milestone set</span>`}${p.status === 'parked' && p.why ? html`<span class="lmx-meta">Paused: ${p.why}${p.until ? ' · until ' + p.until : ''}</span>` : nothing}</div>
    <div class="lmx-planrow-counts">${countChip(p.blocked, 'blocked', 'warning')}${overdueKnown ? countChip(p.overdue, 'overdue', 'danger') : nothing}</div>
    <div class="lmx-planrow-act">${priorityControl(p, redraw)}</div></article>`;
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
    const groups = groupPlanRows(rows), top = groups[0].rows.length;
    renderView('plans', crumbsFor(), html`${workTabs('plans')}
      <header class="lmx-pageheader"><div><span class="lm-eyebrow">Work · ${rows.length} ${rows.length === 1 ? 'plan' : 'plans'}</span><h1>Plans</h1></div></header>
      ${top ? nothing : html`<div class="lm-alert lm-alert--info">${icon('alert')}<div>No plan is Top priority. Open a plan's Priority menu to pick one.</div></div>`}
      ${groups.filter((g) => g.rows.length).map((g) => html`<section class="lmx-plangroup" aria-labelledby=${'pg-' + (g.status || 'none')}><h2 class="lmx-section-title" id=${'pg-' + (g.status || 'none')}>${g.label} <span>${g.rows.length}</span></h2>
        <div class="lmx-planlist">${repeat(g.rows, (p) => p.id, (p) => planRow(p, draw, jobsOk))}</div></section>`)}
      <p class="lmx-meta">${jobsOk ? 'Overdue counts jobs past their due date that are not done.' : 'Overdue counts are unavailable because the work list did not load.'}</p>`);
  };
  draw();
}

// ─── one plan ────────────────────────────────────────────────────────
const ORDER = { blocked: 0, active: 1, open: 2, done: 3 };
const byStage = (a, b) => (ORDER[a.stage] ?? 2) - (ORDER[b.stage] ?? 2) || String(a.title).localeCompare(String(b.title));
function jobRow(j, today) {
  const wait = waitsOn(j, agentName), late = isOverdue(j, today);
  return html`<li class="lmx-tljob" data-stage=${j.stage}>
    <span class="lmx-tljob-owner">${j.owner ? agent(j.owner) : html`<span class="lmx-meta">No owner</span>`}</span>
    <span class="lmx-tljob-title">${jobLink(j.id, j.title)}${wait ? html`<span class="lmx-meta lmx-tljob-wait">${wait}</span>` : nothing}</span>
    <span class="lmx-tljob-state">${stage(j.stage)}${late ? html`<span class="lmx-flag">Overdue · ${j.due}</span>` : j.due && j.stage !== 'done' ? html`<span class="lmx-meta">due ${j.due}</span>` : nothing}</span></li>`;
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
    <section class="lmx-card lmx-plansum" data-key=${'plan:' + p.id} data-l=${p.status || 'none'}>
      <div class="lmx-plansum-head"><div><h2 class="lmx-plansum-title">${p.title}</h2>${laneBadge({ status: p.status }, !p.general)}</div><div class="lmx-planrow-act">${priorityControl(p, draw)}</div></div>
      ${d.desc ? html`<p class="lmx-meta">${d.desc}</p>` : nothing}
      ${p.status === 'parked' && d.lane?.why ? html`<p class="lmx-meta">Paused: ${d.lane.why}${d.lane.until ? ' · until ' + d.lane.until : ''}</p>` : nothing}
      ${progress(done, items.length, percent, p.title + ' progress')}
      <div class="lmx-planrow-counts">${countChip(blocked, 'blocked', 'warning')}${countChip(overdue, 'overdue', 'danger')}<a class="lmx-chiplink" href=${'#/discussion/plan/' + enc(p.id)}>Plan comments</a></div></section>
    <section aria-labelledby="tl-head"><h2 class="lmx-section-title" id="tl-head">Milestones <span>${steps.length}</span></h2>
      ${steps.length ? html`<ol class="lmx-timeline">${steps.map((s) => html`<li class="lmx-tlstep" data-status=${s.status} data-key=${'ms:' + s.milestone.id}>
        <span class="lmx-tlmark" aria-hidden="true"></span>
        <div class="lmx-tlbody"><div class="lmx-tlhead"><span class="lmx-tldate mono">${s.milestone.date || 'No date'}</span><span class="lmx-meta">${s.status === 'done' ? 'Reached' : dayText(s.days)}</span><span class="lmx-mstatus" data-status=${s.status}>${milestoneLabel(s.status)}</span></div>
          <h3>${s.milestone.title}</h3>${s.milestone.criteria ? html`<p class="lmx-tlcrit"><b>Done when:</b> ${s.milestone.criteria}</p>` : nothing}
          ${s.jobs.length ? html`<p class="lmx-meta">${s.done} of ${s.jobs.length} jobs done</p>` : nothing}${jobList(s.jobs, today)}</div></li>`)}</ol>`
        : html`<p class="lmx-meta">This plan has no milestones yet. Agents add one with logmem_assign and details.milestone set to true.</p>`}</section>
    <section class="lmx-card lmx-tlloose" aria-labelledby="tl-loose"><h2 class="lmx-section-title" id="tl-loose">${WORDS.notInMilestone} <span>${loose.length}</span></h2>${loose.length ? jobList(loose, today) : html`<p class="lmx-meta">Every job counts toward a milestone.</p>`}</section>`);
  draw();
}

let okHook = () => true;
export function setPlansOk(fn) { okHook = fn; }
/** #/plans lists every plan; #/plans/<id> opens one. A pulse redraw keeps an open pause form and its text. */
export function plansPage(id) {
  const key = id || '';
  if (ui.route !== key) { ui.route = key; ui.pausing = null; ui.saving = null; }
  return id ? planDetail(id) : plansList();
}
