// views.js — every page. Each answers one question (live app spec, section 4) and is built from
// the shared parts in cards.js and ui.js. All markup is lit-html: nothing is concatenated as HTML.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live as liveDir } from '/vendor/lit-html-3.2.1/directives/live.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { api, getJSON, live, state, num, ago, hhmm, agentName, filt, saveFilt, uniq, isLate } from './core.js';
import { icon, agent, seenTag, fresh, stage, entries, emptyState, panel, kv, table, head, btn, laneBadge, waitsTag, dueTag } from './ui.js';
import { jobCard, planCard, agentChip, boardCard, planRow, agentCard, laneCard, jobLink } from './cards.js';
import { invite } from './actions.js';
import { renderView } from './shell.js';
import { openDrawer, drawerState } from './drawer.js';
import { ADMIN, signOut } from './shell.js';
import { briefFor, prioritizeWork, workFilterKey, groupUpdates } from './dashboard-model.js';
import { writerPage, playerPage } from './walk.js';

import {queuePage} from './interactions.js';
export const pages = {};
pages.queue=queuePage;
pages.discussion=async id=>{const existing=drawerState();if(existing?.kind==='discussion'&&existing.id===id)return;renderView('discussion',['Work','Discussion'],html`<p>Record comments and actions.</p><a href="#/work">Back to work</a>`);return openDrawer('discussion',id);};
let okHook = () => true;
export function setOkHook(fn) { okHook = fn; }
const ok = (d) => okHook(d);
const col = (cls, title, n, body) => html`<section class=${cls}><h2 class="lmx-colhead">${title}${n != null ? html` <b>${n}</b>` : nothing}</h2><div class="lmx-stack">${body}</div></section>`;
const keyed = (list, key, tpl) => repeat(list, key, tpl);

// ─── Today: decisions, waits, source updates, and compact priorities ───
pages.home = async () => {
  const d = await api('home');
  if (!ok(d)) return;
  live.needs = d.needs_count; live.home = d;
  const b = briefFor(d), needs = d.needs_items || [];
  const waits = d.blocked.filter(j => !['task', 'decision'].includes(j.blocked_on?.type));
  const heading = b.decisions ? `${b.decisions === 1 ? 'One decision needs' : b.decisions + ' decisions need'} you.` : 'Your work, in view.';
  if(state.customer&&b.total===0&&!d.agents.length)return renderView('home',['Today'],html`<section class="lm-panel lmx-account-form"><span class="lm-eyebrow">${state.spaceRecords.find(s=>s.id===state.spaceId)?.name}</span><h1>Your space is ready.</h1><p>Add your first task. Connect an agent or invite a teammate when you need them.</p><div class="lmx-account-actions">${state.permissions?.write?html`<a class="lm-btn lm-btn--primary" href="#/new-task">Add a task</a>`:nothing}${state.permissions?.manage?html`<a class="lm-btn" href="#/account">Connect an agent</a><a class="lm-btn" href="#/account">Invite a person</a>`:nothing}</div></section>`);
  const attention = i => html`<article class="lmx-card lmx-attention" data-key=${state.space + ':' + i.type + ':' + i.trail}>
    <span class="lm-eyebrow">${i.type === 'decision' ? 'Your decision' : i.type === 'task' ? 'Your task' : 'Review completion'}</span>
    <h3>${i.summary || i.ask?.summary}</h3><div class="lmx-meta">${i.by ? 'From ' + agentName(i.by) : ''}${i.plan ? ' · ' + i.plan : ''}${i.created_at ? ' · asked ' + ago(i.created_at) : ''}</div>
    ${btn(i.type === 'decision' ? 'Review decision' : i.type === 'task' ? 'Review task' : 'Review evidence', 'primary', () => i.job ? openDrawer('job', i.job) : openDrawer('needs', 'all'))}</article>`;
  renderView('home', ['Today'], html`
    <div class="lmx-today-heading"><div><span class="lm-eyebrow">Your workspace · ${state.customer?state.spaceRecords.find(s=>s.id===state.spaceId)?.name:state.space}</span><h1>${heading}</h1><p>Decide what needs you. Keep the next step in view.</p></div>
      <a class="lm-btn lm-btn--secondary" href="#/audit">Coordination audit</a></div>
    <section class="lmx-brief" aria-label="Your brief"><div><span class="lm-eyebrow">Your brief</span>
      <p>${b.decisions == null ? 'Decision count is unavailable.' : `${b.decisions} ${b.decisions === 1 ? 'decision' : 'decisions'} and ${b.tasks} ${b.tasks === 1 ? 'task' : 'tasks'} for you to review.`}
      ${b.blocked} ${b.blocked === 1 ? 'job is' : 'jobs are'} waiting. ${b.done} of ${b.total} work items are done.</p>
      <button type="button" class="lm-btn lm-btn--ghost" @click=${()=>document.getElementById('today-updates')?.scrollIntoView()}>Read the source updates ↓</button></div><span class="lmx-meta">Updated ${d.generated_at ? ago(d.generated_at) : 'on this read'} · partial coverage</span></section>
    <details class="lmx-coverage"><summary>What this view covers</summary><p>The full unanswered coordination queue is not available here yet. Counts describe the records this view read.</p>
      ${(d.coverage?.notes || []).map(n => html`<p>${n}</p>`)}${(d.coverage?.errors || []).map(e => html`<p role="alert">${e.source}: ${e.message}</p>`)}</details>
    <div class="lmx-today-grid"><div class="lmx-stack">
      <section><h2 class="lmx-section-title">Needs your attention <span>${needs.length}</span></h2><div class="lmx-attention-grid">${needs.length ? keyed(needs, i => state.space + ':' + i.type + ':' + i.trail, attention) : emptyState('No personal requests were returned.', 'The coordination backlog may contain other unanswered requests. See coverage above.')}</div></section>
      <section><h2 class="lmx-section-title">Waiting on your team <span>${waits.length}</span></h2><div class="lmx-stack">${waits.length ? keyed(waits, j => j.id, j => jobCard(j, {route:'home'})) : emptyState('No other blocked jobs were returned.', 'This is not a complete handoff backlog.')}</div></section>
      <section id="today-updates"><h2 class="lmx-section-title">Recent job updates</h2><div class="lmx-card lmx-update-list">${groupUpdates(d.recent || []).groups.slice(0,6).map(g => g.entries[0]).map(e => html`<div class="lmx-update"><div class="lmx-meta">${hhmm(e.ts)} · ${agentName(e.by)} · ${e.kind}</div><p>${e.summary}</p><a href=${'#/job/' + encodeURIComponent(e.where.replace(/^job:/,''))}>Open work →</a></div>`)}${!d.recent?.length ? html`<p class="lmx-meta">No recent job updates were returned. See coverage above.</p>` : nothing}</div><a href="#/activity" class="lmx-text-link">View Activity →</a></section>
    </div><aside class="lmx-stack"><section><h2 class="lmx-section-title">Current priorities</h2><div class="lmx-stack">${keyed(d.plans, p => p.id, p => planCard(p, 'home'))}</div><a href="#/work" class="lmx-text-link">Open all work →</a></section>
      <section class="lmx-card"><h3>Your team</h3><p class="lmx-why">${d.agents.length} agents have records in this space. Recent entries show reporting activity, not whether an agent is running.</p><a href="#/agents" class="lmx-text-link">Review agents →</a></section></aside></div>`);
};
pages.overview = pages.home;
pages.decisions = async () => { location.replace('#/home'); openDrawer('needs', 'decisions'); };
pages.blockers = async () => { location.replace('#/home'); openDrawer('needs', 'tasks'); };

// ─── Lanes: every plan as a lane, P0 first ──────────────────────────
pages.lanes = async () => {
  const d = await api('lanes');
  if (!ok(d)) return;
  const R = 'lanes';
  const by = (st) => d.lanes.filter((l) => (l.lane ? l.lane.status : null) === st && l.id !== 'general');
  const p0 = by('p0'), act = by('active'), park = by('parked'), none = d.lanes.filter((l) => !l.lane || !l.lane.status || l.id === 'general');
  const sec = (title, n, body) => html`<section><h2 class="lmx-colhead">${title} <b>${n}</b></h2>${body}</section>`;
  const grid = (ls) => html`<div class="lmx-grid">${keyed(ls, (l) => l.id, (l) => laneCard(l, false, R))}</div>`;
  renderView(R, ['Lanes'], html`
    ${p0.length ? laneCard(p0[0], true, R) : html`<div class="lm-alert lm-alert--warning">${icon('alert')}<div>No P0 lane is set. Pick one below with <b>Make P0</b>.</div></div>`}
    ${sec('Active', act.length, act.length ? grid(act) : html`<p class="lmx-meta">No other active lanes.</p>`)}
    ${sec('Parked', park.length, park.length ? grid(park) : html`<p class="lmx-meta">Nothing parked.</p>`)}
    ${none.length ? sec('No lane set', none.length, grid(none)) : nothing}`);
};

// ─── Plans: one lane in detail ───────────────────────────────────────
pages.plan = async (name) => {
  const d = await api('plan', name ? { id: name } : {});
  if (!ok(d)) return;
  if (!d.plan) { renderView('plan', ['Lanes'], emptyState('No plans yet.', 'Agents open jobs in a plan with logmem_assign and details.plan.')); return; }
  const items = d.tracks.reduce((a, t) => a.concat(t.items), []);
  const done = items.filter((i) => i.stage === 'done').length;
  const late = items.filter((i) => isLate(i.due, i.stage));
  const blocked = items.filter((i) => i.stage === 'blocked').length;
  const toward = (m) => items.filter((i) => i.milestone && (i.milestone === m.id || String(m.title).indexOf(i.milestone + ':') === 0));
  const msName = (k) => { const m = d.milestones.find((x) => x.id === k); return m ? m.title + (m.date ? ' · ' + m.date : '') : k; };
  renderView('plan', [html`<a href="#/lanes">Lanes</a>`, d.title || d.plan], html`
    <div class="lmx-stagechips">${d.plans.map((p) => html`<a href=${'#/plan/' + encodeURIComponent(p)} role="tab" aria-selected=${p === d.plan}>${p}</a>`)}</div>
    <section class="lmx-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h3 style="font-size:18px">${laneBadge(d.lane)}${d.title || d.plan}</h3><span class="lmx-pct">${num(d.percent)}%</span></div>
      <div class="lmx-bar"><i style=${`width:${num(d.percent)}%`}></i></div>
      <div class="lmx-meta">${done} of ${items.length} done${blocked ? html` · <b style="color:var(--warning)">${blocked} blocked</b>` : nothing}${late.length ? html` · <b style="color:var(--danger)">${late.length} late</b>` : nothing}</div></section>
    <a class="lm-btn lm-btn--secondary" href=${'#/discussion/plan/'+encodeURIComponent(d.plan)}>Plan comments</a>
    ${d.milestones.length ? html`<div class="lmx-rail-ms">${d.milestones.map((m) => { const mine = toward(m), md = mine.filter((i) => i.stage === 'done').length; return html`<div class="lmx-card lmx-ms" data-key=${'ms:' + m.id} ?data-done=${m.stage === 'done'}><span class="lmx-meta mono">${m.date || 'no date'}</span><h3>${m.title}</h3><div class="lmx-why">${m.criteria}</div><div class="lmx-meta">${stage(m.stage)}${mine.length ? ` · ${md}/${mine.length} jobs` : ''}</div></div>`; })}</div>` : nothing}
    ${late.length ? html`<section class="lmx-card"><h3>Late</h3>${late.map(planRow)}</section>` : nothing}
    <div class="lmx-stack">${d.tracks.map((t) => {
      const groups = {}; t.items.forEach((i) => { const k = i.milestone || 'No milestone'; (groups[k] = groups[k] || []).push(i); });
      const keys = Object.keys(groups).sort((a, b) => (a === 'No milestone') - (b === 'No milestone') || a.localeCompare(b));
      const td = t.items.filter((i) => i.stage === 'done').length;
      return html`<section class="lmx-card lmx-track" data-key=${'track:' + t.title}><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><h3>${t.title}</h3><span class="lmx-meta">${td}/${t.items.length} · ${num(t.percent)}%</span></div><div class="lmx-bar"><i style=${`width:${num(t.percent)}%`}></i></div>
        ${keys.map((k) => html`<div class="lmx-pgroup"><div class="lmx-colhead" style="margin:10px 0 4px">${msName(k)}</div>${groups[k].map(planRow)}</div>`)}</section>`;
    })}</div>`);
};

// ─── Filters (Jobs and Log) ──────────────────────────────────────────
function selectBox(view, key, label, values, redraw) {
  const cur = filt(view)[key] || '';
  return html`<label class="lmx-f"><span>${label}</span><select class="lm-select" @change=${(e) => { filt(view)[key] = e.target.value; if (key === 'plan') delete filt(view).track; saveFilt(); redraw(); }}>
    <option value="">All</option>${values.map((v) => html`<option ?selected=${v === cur}>${v}</option>`)}</select></label>`;
}
function searchBox(view, ph, redraw) {
  let t;
  return html`<label class="lmx-f lmx-f-q"><span>Search</span><input class="lm-input" type="search" .value=${liveDir(filt(view).q || '')} placeholder=${ph}
    @input=${(e) => { filt(view).q = e.target.value; saveFilt(); clearTimeout(t); t = setTimeout(redraw, 150); }}></label>`;
}

// ─── Jobs: "Where is a given piece of work?" ────────────────────────
const BOARD = [['open', 'Open'], ['active', 'Active'], ['blocked', 'Blocked'], ['done', 'Done, last 7 days']];
function drawJobs() {
  const R = workFilterKey(state.space);
  const all = prioritizeWork(live.jobs || []);
  const f = filt(R), q = (f.q || '').toLowerCase(), week = Date.now() - 7 * 86400e3;
  const list = all.filter(j => (!f.plan || j.plan === f.plan) && (!f.track || j.track === f.track) && (!f.owner || agentName(j.owner) === f.owner)
    && (!q || (j.title + ' ' + j.id + ' ' + (j.last ? j.last.summary : '')).toLowerCase().includes(q)) && !(j.stage === 'done' && j.stage_at && j.stage_at < week));
  const tracks = uniq(all.filter(j => !f.plan || j.plan === f.plan).map(j => j.track));
  const layout = f.layout === 'board' ? 'board' : 'list';
  const setLayout = value => () => { f.layout = value; saveFilt(); drawJobs(); };
  const pick = f.stage || (list.some(j => j.stage === 'blocked') ? 'blocked' : 'active');
  const setPick = st => () => { f.stage = st; saveFilt(); drawJobs(); };
  const row = j => html`<article class="lmx-work-row" data-key=${j.id}><div><h3><a href=${'#/job/' + encodeURIComponent(j.id)}>${j.title}</a></h3><div class="lmx-meta">${j.plan || 'No plan'}${j.track ? ' · ' + j.track : ''} · ${j.owner ? agentName(j.owner) : 'Owner not assigned'}</div></div>
    <div>${stage(j.stage)}${j.blocked_on?.parked ? html`<span class="lm-badge">Parked</span>` : nothing}</div><div class="lmx-why">${j.blocked_on?.note || j.last?.summary || 'No next step recorded.'}</div><div class="lmx-meta">${j.due || 'No due date'}${j.due ? dueTag(j.due, j.stage) : nothing}</div></article>`;
  const unknown = list.filter(j => !BOARD.some(b => b[0] === j.stage));
  renderView('work', ['Work'], html`${head('Work', 'Priorities, owners, and the next step.')}<div class="lmx-work-toolbar"><div class="lmx-tabsbar" role="group" aria-label="Work layout"><button type="button" aria-pressed=${layout === 'list'} @click=${setLayout('list')}>List</button><button type="button" aria-pressed=${layout === 'board'} @click=${setLayout('board')}>Board</button></div><a href="#/lanes" class="lm-btn lm-btn--secondary">Plans and milestones</a><a href="#/queue" class="lm-btn lm-btn--secondary">Coordination queue</a></div>
    <div class="lmx-filters">${selectBox(R, 'plan', 'Plan', uniq(all.map(j=>j.plan)), drawJobs)}${selectBox(R, 'track', 'Track', tracks, drawJobs)}${selectBox(R, 'owner', 'Owner', uniq(all.map(j=>agentName(j.owner))), drawJobs)}${searchBox(R, 'Title or last entry', drawJobs)}</div>
    ${layout === 'list' ? html`<div class="lmx-work-list">${list.length ? keyed(list, j=>j.id, row) : emptyState('No work matches these filters.', 'Clear a filter or select another plan.')}</div>` : html`
      <div class="lmx-stagechips lmx-phone-only" role="tablist">${BOARD.map(b=>html`<button type="button" role="tab" aria-selected=${pick === b[0]} @click=${setPick(b[0])}>${b[1].split(',')[0]} ${list.filter(j=>j.stage===b[0]).length}</button>`)}</div>
      <div class="lmx-board">${BOARD.map(b=>{ const mine=list.filter(j=>j.stage===b[0]); return html`<section class="lmx-boardcol" data-stage=${b[0]} ?data-pick=${pick===b[0]}><h2 class="lmx-colhead">${b[1]} <b>${mine.length}</b></h2><div class="lmx-stack">${keyed(mine,j=>j.id,j=>boardCard(j,'work'))}${!mine.length ? html`<p class="lmx-meta">None.</p>` : nothing}</div></section>`; })}</div>
      ${unknown.length ? html`<section><h2 class="lmx-section-title">Unrecognized stages</h2>${unknown.map(row)}</section>` : nothing}`}
    <p class="lmx-meta">${list.length} matching work items. Milestones are listed under Plans and milestones. Done work from the last seven days appears here.</p>`);
}
pages.jobs = async () => { const d = await api('jobs'); if (!ok(d)) return false; live.jobs = d.jobs; drawJobs(); return true; };
pages.work = pages.jobs;
// Signed out, the sign-in form shows and no panel opens over it.
pages.job = async (id) => { if (!(await pages.jobs())) return; const ds = drawerState(); if (!ds || ds.id !== id) openDrawer('job', id); };

// ─── Agents: "Who is doing what, and are they healthy?" ─────────────
// Walkthroughs: the writer (in the frame) and the player (no admin rail).
pages.write = writerPage;
pages.walk = playerPage;

pages.agents = async () => {
  const d = await api('agents');
  if (!ok(d)) return;
  const liveN = d.agents.filter((a) => a.seen.state === 'active').length;
  renderView('agents', ['Agents'], html`<div class="lmx-filters"><span class="lmx-meta">${liveN} of ${d.agents.length} wrote in the last 15 minutes. This is reporting activity, not runtime presence.</span><span class="lm-spacer"></span><a href="/keys" class="lm-btn lm-btn--secondary" style="text-decoration:none">Agent keys</a></div>
    <section class="lmx-capability-note"><strong>Run and schedule receipts are not connected yet.</strong><p>Request a run and Pause future runs remain unavailable until this space has a verified runner and enforceable limits.</p></section><div class="lmx-grid">${keyed(d.agents, (a) => a.id, agentCard)}</div>`);
};
pages.agent = async (id) => {
  const d = await api('agent', { id });
  if (!ok(d)) return;
  const r = d.recap, follows = Object.keys(d.follows || {});
  const recap = r ? html`<p style="margin:0 0 10px;font-size:15px">${r.summary}</p>${r.next && r.next.length ? html`<span class="lm-eyebrow">Next</span><ul style="margin:4px 0 10px;padding-left:18px">${r.next.map((n) => html`<li>${n}</li>`)}</ul>` : nothing}<div class="lm-prov"><span>${r.mode}${r.reason ? ' · ' + r.reason : ''}</span><span>shift ${r.shift}</span><span>${ago(r.ended_at)}</span></div>` : emptyState('No Recap yet.', 'This agent has not finished a shift.');
  const shifts = (d.shifts || []).map((s) => html`<tr><td class="mono" style="font-size:12px">${s.shift || ''}</td><td style="font-size:13px">${s.surface || ''}</td><td style="font-size:13px">${hhmm(s.ts)}</td><td style="font-size:13px">${s.auto ? 'auto' : 'manual'}</td></tr>`);
  renderView('agent', [html`<a href="#/agents">Agents</a>`, id], html`<div class="lm-row" style="gap:14px">${agent('agent:' + id)}${seenTag(d.seen)}</div>
    <p style="margin:0;font-size:13px" class="muted">Current reports for ${id}. Recent activity does not prove a running process. Schedule coverage and run controls are not verified.</p>
    <div class="grid2">${panel('Last Recap', recap)}${panel('Now', kv(d.now))}${panel('Handoffs waiting for ' + id, d.handoffs.length ? entries(d.handoffs) : emptyState('Nothing waiting.', 'Handoffs show here until the agent accepts or declines them.'))}
      ${panel('Follows', follows.length ? follows.map((f) => html`<div class="lm-row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span class="mono" style="font-size:13px">${f}</span><span class="lm-badge">${(d.follows[f] || {}).role || ''}</span></div>`) : emptyState('Follows nothing.', 'Handoffs and logmem_follow add channels and jobs here.'))}</div>
    ${panel('Recent shifts', shifts.length ? table(['Shift', 'Host', 'Started', 'Start'], shifts) : emptyState('No shifts.', ''))}${panel('Log', entries(d.log))}`);
};

// ─── Log: "What exactly happened?" ──────────────────────────────────
function drawLog() {
  const all = live.log || [], f = filt('log'), q = (f.q || '').toLowerCase(), rc = live.recall;
  const list = all.filter((e) => (f.allEvents || e.group !== 'system') && (!f.where || String(e.where || '').indexOf(f.where + ':') === 0 || e.where === f.where) && (!f.agent || agentName(e.by) === f.agent) && (!f.kind || e.group === f.kind) && (!q || String(e.summary || '').toLowerCase().includes(q)));
  const places = ['job', 'channel', 'agent'].concat(uniq(all.map((e) => (/^channel:/.test(e.where || '') ? e.where : null))));
  let rq = rc ? rc.q : '';
  const grouped = groupUpdates(list);
  renderView('log', ['Activity'], html`${head('Activity', 'Recent source entries. This bounded window is not the full coordination backlog.')}<div class="lmx-tabsbar" role="group" aria-label="Activity detail"><button type="button" aria-pressed=${!f.allEvents} @click=${()=>{f.allEvents=false;saveFilt();drawLog();}}>Work updates</button><button type="button" aria-pressed=${!!f.allEvents} @click=${()=>{f.allEvents=true;saveFilt();drawLog();}}>All events</button></div>
    <form class="lmx-filters" role="search" @submit=${(e) => { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(e.target.q.value); }}>
      <label class="lmx-f lmx-f-q"><span>Recall</span><input class="lm-input" name="q" .value=${liveDir(rq)} placeholder="what did we decide about…"></label><button class="lm-btn lm-btn--primary" style="align-self:flex-end">Recall</button></form>
    <div class="lmx-filters">${selectBox('log', 'where', 'Where', places, drawLog)}${selectBox('log', 'agent', 'Who', uniq(all.map((e) => agentName(e.by))), drawLog)}${selectBox('log', 'kind', 'Kind', uniq(all.map((e) => e.group)), drawLog)}${searchBox('log', 'Words in the entry', drawLog)}</div>
    ${rc ? html`<section class="lmx-card"><h3>Recall: “${rc.q}”</h3>${rc.results.length ? rc.results.map((r) => html`<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="lm-kind">${r.kind}</span> ${r.summary}<div class="lmx-meta mono">${r.from} · trail ${r.trail || ''}</div></div><span class="lmx-meta">${ago(r.ts)}</span></div>`) : html`<p class="lmx-meta">No matches. Try fewer or different words.</p>`}</section>` : nothing}
    <section class="lm-panel" style="padding:8px 16px 16px">${f.allEvents ? entries(list) : html`${grouped.invalid.length ? html`<p role="alert">${grouped.invalid.length} updates have invalid or future timestamps. Inspect All events for their source records.</p>` : nothing}${grouped.groups.length ? grouped.groups.map(g=>html`<section class="lmx-activity-group"><h2 class="lmx-section-title">${g.where.startsWith('job:') ? html`<a href=${'#/job/'+encodeURIComponent(g.where.slice(4))}>${g.where}</a>` : g.where}</h2>${entries(g.entries)}</section>`) : emptyState('No work updates match.', 'Clear a filter or inspect All events. This is a bounded read window.')}` }<p class="lmx-meta">${list.length} of ${all.length} recent entries.</p></section>`);
}
pages.activity = () => pages.log();
pages.log = async () => { live.recall = null; const d = await api('log'); if (!ok(d)) return; live.log = d.entries; drawLog(); };
pages.recall = async (q) => {
  const query = q || '';
  const [l, r] = await Promise.all([api('log'), query ? api('recall', { q: query }) : Promise.resolve({ results: [] })]);
  if (!ok(l)) return;
  live.log = l.entries; live.recall = query ? { q: query, results: r.results || [] } : null; drawLog();
};
pages.channels = async (id) => { filt('log').where = id ? 'channel:' + id : 'channel'; saveFilt(); return pages.log(); };

// ─── Admin pages ─────────────────────────────────────────────────────
pages.settings = async () => {
  const d = await api('settings');
  if (!ok(d)) return;
  renderView('settings', ['Settings'], html`${head('Settings', 'Connections and administration for this space.')}<div class="lmx-settings-links">${ADMIN.filter(n=>n[0]!=='settings').map(n=>html`<a class="lm-btn lm-btn--secondary" href=${n[3] || '#/'+n[0]}>${n[1]}</a>`)}${btn('Sign out', 'secondary', signOut)}</div>${panel('Space', kv({ space: d.space, keys: d.keys }))}
    ${panel('Storage', html`<div style="display:flex;flex-direction:column;gap:10px">${fresh('fresh', 'PING ' + d.ping_ms + ' ms')}<span style="font-size:13px" class="muted">Your Redis, over the deploy’s bridge connection.</span></div>`)}
    ${panel('ACMI compatibility', kv({ 'compatibility mode': d.compat ? 'on' : 'off', 'mirror to ACMI': d.mirror ? 'on for ' + d.mirror_spaces.join(', ') : 'off' }))}`);
};
pages.audit = async () => {
  const d = await api('audit');
  if (!ok(d)) return;
  const g = d.gate || {}, last7 = (d.days || []).slice(-7);
  const strip = Array.from({ length: 7 }, (_, i) => { const x = last7[i - (7 - last7.length)]; const st = !x ? 'background:var(--surface-sunken);color:var(--text-subtle)' : x.pass ? 'background:var(--success-subtle);color:var(--success)' : 'background:var(--danger-subtle);color:var(--danger)'; return html`<div style=${'display:flex;flex-direction:column;align-items:center;padding:10px 4px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;' + st}><span>${x ? x.date.slice(5) : '—'}</span><span>${x ? (x.pass ? 'PASS' : 'FAIL') : '—'}</span></div>`; });
  const rows = (d.days || []).slice().reverse().map((x) => html`<tr style="font-variant-numeric:tabular-nums"><td>${x.date}</td><td><span class=${'lm-badge lm-badge--' + (x.pass ? 'success' : 'danger')}>${x.pass ? 'Pass' : x.health_pass ? 'Low volume' : 'Fail'}</span></td><td>${num((x.agents || []).length)}</td><td>${num(x.entries)}</td><td>${num(x.accepted)} / ${num(x.handoffs)}</td><td>${x.mirror_checked ? num(x.mirror_mismatches) : 'n/a'}</td><td>${num(x.unanswered_24h)}</td><td>${num(x.degraded_sessions)}</td></tr>`);
  // The coordination queue: open handoffs, seats and directed requests, sorted by how overdue they are.
  const q = d.pending || { items: [], total: 0, counts: {} };
  const c = q.counts || {};
  const late = (i) => Number.isFinite(Number(i.deadline)) && Number(i.deadline) > 0 && Date.now() > Number(i.deadline);
  const deadline = (i) => { const n=Number(i.deadline); return Number.isFinite(n)&&n>0 ? new Date(n).toLocaleString() : 'Timestamp unavailable'; };
  const qrows = (q.items || []).map((i) => html`<tr style="font-variant-numeric:tabular-nums">
    <td><span class=${'lm-badge lm-badge--' + (late(i) ? 'danger' : 'neutral')}>${i.type || 'handoff'}</span></td>
    <td>${i.summary || '—'}</td>
    <td class="mono">${agentName(i.from) || '—'} → ${agentName(i.to) || '—'}</td>
    <td>${i.created_at ? ago(i.created_at) : '—'}</td>
    <td>${deadline(i)}${late(i) ? ' · overdue' : ''}</td>
    <td class="mono" style="font-size:12px">${i.where || ''}</td></tr>`);
  const queue = html`<section class="lmx-stack">
    <h2 class="lmx-section-title">Open coordination queue <span>${num(q.total)}</span></h2>
    <p class="muted" style="font-size:13px">${num(c.handoffs)} handoffs · ${num(c.seats)} seats · ${num(c.directed)} directed · ${num(c.overdue)} overdue · coverage ${d.coverage || 'partial'}. Sorted by how overdue they are.</p>
    ${d.coverage !== 'full' ? html`<div class="lm-alert lm-alert--warning"><p>Coverage is incomplete. These results do not describe the full coordination backlog.</p></div>` : nothing}
    <p class="lmx-meta">Showing ${num(qrows.length)} of ${num(q.total)} returned records.</p>
    ${qrows.length ? table(['Type', 'Summary', 'From → To', 'Age', 'Deadline', 'Where'], qrows) : emptyState('No open records were returned.', d.coverage === 'full' ? 'No unanswered handoffs, seats or directed requests were found.' : 'Check coverage before treating this as an empty backlog.')}
    <a class="lm-btn lm-btn--secondary" href="#/queue">Open full queue and nudge</a>
    ${(d.data_errors || []).length ? html`<p class="muted" style="font-size:12px">${d.data_errors.length} data error(s) flagged: ${d.data_errors.slice(0, 3).map((e) => e.type).join(', ')}</p>` : nothing}</section>`;
  renderView('audit', ['Audit'], html`${queue}${head('Audit', 'The daily check that nothing was lost or left hanging. Each run writes a checkup entry to job:logmem-dogfood.')}
    <section class="lm-panel" style="padding:20px;display:flex;flex-wrap:wrap;gap:24px;align-items:center"><div style="flex:1 1 280px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">7-day gate</span><span style="font-size:22px;font-weight:600">${g.pass ? 'Pass' : `Not yet: ${g.days_passing || 0} of last 7 passing`}</span><span style="font-size:13px" class="muted">Needs 7 consecutive passing days and the deliverable done.</span></div>
      <div style="flex:2 1 420px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">${strip}</div><div style="flex:1 1 200px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">Deliverable</span>${stage((d.deliverable || {}).stage)}<span class="mono subtle" style="font-size:12px">job:${(d.deliverable || {}).job || ''}</span></div></section>
    ${rows.length ? table(['Day', 'Result', 'Agents', 'Entries', 'Handoffs accepted', 'Mirror mismatches', 'Unanswered >24h', 'Degraded'], rows) : emptyState('No checks yet.', 'The first daily check writes its result here.')}`);
};
async function markInvited(rows, inv) {
  if (!inv || !window.crypto || !crypto.subtle) return rows.map(() => false);
  const set = new Set((inv.invites || []).map((x) => x.hash));
  return Promise.all(rows.map(async (x) => { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(x.email || '').trim().toLowerCase())); return set.has([...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')); }));
}
pages.waitlist = async () => {
  const [d, inv] = await Promise.all([getJSON('/api/waitlist'), fetch('/api/invites', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  if (!ok(d)) return;
  const invited = await markInvited(d.rows || [], inv), canInvite = !!inv;
  const counts = (title, list, key) => panel(title, list.length ? html`<dl class="lm-kv">${list.map((x) => html`<dt>${x[key]}</dt><dd>${num(x.n)}</dd>`)}</dl>` : html`<span class="subtle" style="font-size:13px">None yet.</span>`);
  const pending = (d.rows || []).filter((x, i) => !invited[i]).map((x) => x.email);
  const rows = (d.rows || []).map((x, i) => html`<tr style="font-variant-numeric:tabular-nums"><td>${x.email}</td><td>${x.plan || '—'}</td><td>${x.agents == null ? '—' : num(x.agents)}</td><td>${x.utm_source || 'direct'}</td><td>${x.referrer_host || '—'}</td><td>${new Date(x.ts).toISOString().slice(0, 10)}</td><td>${num(x.count)}</td>
    <td>${!canInvite ? '—' : invited[i] ? html`<span class="subtle">Invited</span>` : btn('Invite', 'secondary', (e) => invite(e, [x.email]))}</td></tr>`);
  const right = html`<span style="display:flex;gap:8px">${canInvite && pending.length ? btn(`Invite all ${pending.length} not invited`, 'primary', (e) => { if (window.confirm(`Invite ${pending.length} people to the beta?`)) invite(e, pending.slice(0, 200)); }) : nothing}<a class="lm-btn lm-btn--secondary" href="/api/waitlist?format=csv" download>Download CSV</a></span>`;
  const note = canInvite ? (inv.open ? ' Sign-up is open to everyone.' : ' Invite people into the managed beta.') : ' Invites need the customer Redis on this deploy.';
  renderView('waitlist', ['Waitlist'], html`${head('Waitlist', `${num(d.total)} sign-ups. Each row keeps the first visit’s source.${note}`, right)}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">${counts('By source', d.by_source || [], 'source')}${counts('By plan', d.by_plan || [], 'plan')}${counts('By day', (d.by_day || []).slice(-14), 'day')}</div>
    ${rows.length ? table(['Email', 'Plan', 'Agents', 'Source', 'Referrer', 'First sign-up', 'Times', 'Beta'], rows) : emptyState('No sign-ups yet.', 'Sign-ups from /onboarding appear here.')}`);
};
pages.more = async () => {
  const link = (n) => html`<a class="lmx-card" style="text-decoration:none;color:inherit;flex-direction:row;align-items:center;gap:10px" href=${n[3] || '#/' + n[0]}>${icon(n[2])}<h3>${n[1]}</h3></a>`;
  renderView('more', ['More'], html`<div class="lmx-stack">${[['agents', 'Agents', 'agents'], ['log', 'Log', 'timeline'], ['recall', 'Recall', 'recall']].map(link)}<h2 class="lmx-colhead" style="margin-top:12px">Admin</h2>${ADMIN.map(link)}<button type="button" class="lm-btn lm-btn--secondary" style="margin-top:12px" @click=${signOut}>Sign out</button></div>`);
};
export { jobLink, waitsTag, dueTag, state };
