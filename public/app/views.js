// views.js — every page. Each answers one question (live app spec, section 4) and is built from
// the shared parts in cards.js and ui.js. All markup is lit-html: nothing is concatenated as HTML.
import { html, nothing, svg } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live as liveDir } from '/vendor/lit-html-3.2.1/directives/live.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { getJSON, live, state, num, ago, hhmm, agentName, filt, saveFilt, uniq, isLate } from './core.js';
import { idChip, textWithIds } from './ui.js';
import { filterActivity, dayGroups, KIND_GROUPS, placeLink, relTime, fullTime, clock24 } from './brief-model.js';
import { icon, agent, seenTag, fresh, stage, decision, entries, emptyState, panel, kv, table, head, btn, laneBadge, waitsTag, dueTag } from './ui.js';
import { jobCard, planCard, agentChip, boardCard, planRow, agentCard, jobLink, askCard, copy } from './cards.js';
import { invite } from './actions.js';
import {launchpad,setupStrip} from './launchpad.js';
import {groupControl,logList,inspector,recallCard,recallExplainer} from './log-components.js';
import {groupByMode,logRows,entryKey,matchTerms,appendOlder,olderCursor} from './log-model.js';
import {earliestPass} from './canvas-detail-model.js';
import {moreGroups} from './nav-model.js';
import {viewOnlyNote,riskNote,inviteAllConfirm,inviteAllLabel,SETTINGS_NOTE,AUDIT_NOTE,INVITE_RISK} from './admin-notes.js';
import {healthQueueItems,auditDays,overdueRequest,unindexedRequest} from './health-model.js';
import {healthRequestRow,auditBreakdownCard} from './health-components.js';
import {observeTelemetry} from './telemetry-state.js';
import {bentoTaskCard,waitingTeamCard} from './today-components.js';
import {pageHeader,promiseStrip,statTiles,agentsList,handoffCard,recentFeed} from './brief-view.js';
import {handoffInFlight} from './brief-model.js';
import {workspaceAssistant} from './shell.js';
import { renderView } from './shell.js';
import { load } from './data.js';
import { openDrawer, drawerState } from './drawer.js';
import { ADMIN, signOut, themePicker } from './shell.js';
import { briefFor, prioritizeWork, workFilterKey, groupUpdates, canAnswerDecision, splitHeadline, attentionKind, attentionCounts, filterAttention, splitPlans, PLAN_MODES, planMatch, planCounts, mergeTracks, dueState, WORK_MODES, workMatch, workCounts, trackKey, trackLabels, blockerNote, sharedBlockers, AGENT_MODES, agentMatch, agentCounts, groupDecisions, verdictLabel, agentColor, decisionGraph, splitDecisionRows, BOARD_FILTERS, boardMatch, boardCounts } from './dashboard-model.js';
import { writerPage, playerPage } from './walk.js';
import { handoffMap, timeScrubber, fleetPulse, blockerMap } from './flow-views.js';
import { agentProfile } from './profile-components.js';
import { blockerKind } from './flow-model.js';

import {agentDispatchButton,clusterBlockerGroup} from './dispatch-components.js';
import { agentDispatchPrompt } from './dispatch-model.js';
import { initials } from './dashboard-model.js';
import { agentIcon, savedAgentIcon } from './agent-icons.js';
import { activityTimelineGroup, agentRosterCards, agentsRosterTable, shiftTimelineSection } from './ui-21st.js';
import {seedCard} from './seed-components.js';
import {blockerClusters} from './flow-model.js';
import {ticketPrompt,jobDispatchPrompt,isStaleTicket} from './dispatch-model.js';
import {queuePage} from './interactions.js';
import {plansPage,setPlansOk} from './plans-view.js';
import {STAGE_LABEL} from './labels.js';
export const pages = {};
pages.queue=queuePage;
pages.discussion=async id=>{const existing=drawerState();if(existing?.kind==='discussion'&&existing.id===id)return;renderView('discussion',['Work','Discussion'],html`<p>Record comments and actions.</p><a href="#/work">Back to work</a>`);return openDrawer('discussion',id);};
let okHook = () => true;
export function setOkHook(fn) { okHook = fn; }
const ok = (d) => okHook(d);
const col = (cls, title, n, body) => html`<section class=${cls}><h2 class="lmx-colhead">${title}${n != null ? html` <b>${n}</b>` : nothing}</h2><div class="lmx-stack">${body}</div></section>`;
const keyed = (list, key, tpl) => repeat(list, key, tpl);

// ─── Brief: what needs you, the numbers, who is working, and what just happened ───
// No hero. One header, the promise strip, an optional status strip (shell), four linked tiles, then work.
pages.home = async () => {
  // The Inbox tile reads the first queue page. A cold load learns the space from home first.
  const readQueue = () => getJSON('/api/interactions?' + new URLSearchParams({ space: state.space || '', queue: '1' })).catch(() => null);
  const early = state.space ? readQueue() : null;
  const d = await load('home');
  if (!ok(d)) return;
  const queue = await (early || readQueue());
  live.needs = d.needs_count; live.home = d;
  observeTelemetry(state.space,{decisions:{value:Array.isArray(d.needs_items)?d.needs_items.filter(i=>i.type==='decision').length:null}});
  const b = briefFor(d), needs = d.needs_items || [];
  const spaceLabel = state.customer ? state.spaceRecords.find(s=>s.id===state.spaceId)?.name || state.space : state.space;
  // A workspace with no work at all shows the full setup; otherwise setup is one compact strip below the numbers.
  if(state.customer&&b.total===0&&!d.agents.length)return renderView('home',['Brief'],html`${pageHeader('Space ' + spaceLabel, 'Brief')}<h2 class="lmx-section-title">Your space is ready.</h2>${launchpad({data:d,space:state.space,refresh:()=>pages.home()})}${seedCard({project:state.spaceRecords.find(s=>s.id===state.spaceId)?.name||state.space})}`);
  const q = queue && queue.__status === 200 && Array.isArray(queue.items) ? queue : null;
  const review = i => i.type==='task' ? openDrawer('needs','tasks') : i.job ? openDrawer('job',i.job) : openDrawer('needs','all');
  const attention = i => bentoTaskCard({item:i,space:state.space,review:()=>review(i)});
  const waits = d.blocked.filter(j => !['task', 'decision'].includes(j.blocked_on?.type));
  const errors = d.coverage?.errors || [];
  renderView('home', ['Brief'], html`
    ${pageHeader('Space ' + spaceLabel, 'Brief')}
    ${promiseStrip({ needs, review })}
    ${statTiles({ needs, queue: q, agents: d.agents, plans: d.plans }, () => openDrawer('needs', 'all'))}
    ${setupStrip({data:d,space:state.space,refresh:()=>pages.home()})}
    <div class="lmx-brief-grid">
      ${agentsList(d.agents || [])}
      <div class="lmx-stack">${handoffCard(q ? handoffInFlight(q.items) : null)}${recentFeed(d.recent || [])}</div>
    </div>
    ${needs.length ? html`<section id="today-board"><h2 class="lmx-section-title">Needs your attention <span>${needs.length}</span></h2><div class="lmx-attention-grid">${keyed(needs, i => state.space + ':' + i.type + ':' + i.trail, attention)}</div></section>` : nothing}
    ${waits.length ? html`<section id="today-waiting"><h2 class="lmx-section-title">Waiting on your team <span>${waits.length}</span></h2><div class="lmx-waiting-list">${keyed(waits, j => j.id, waitingTeamCard)}</div></section>` : nothing}
    <details class="lmx-coverage lmx-coverage--quiet"><summary>About these numbers</summary><p>Counts come from the records loaded for this view${d.generated_at ? ', read ' + ago(d.generated_at) : ''}. The Inbox tile reads its first page.</p>${(d.coverage?.notes || []).map(n => html`<p>${n}</p>`)}${errors.map(e => html`<p role="alert">${e.source}: ${e.message}</p>`)}</details>`);
};
pages.overview = pages.home;
pages.brief = pages.home;
pages.needs = async () => { location.replace('#/home'); openDrawer('needs', 'all'); };
pages.decisions = async () => { location.replace('#/home'); openDrawer('needs', 'decisions'); };
pages.blockers = async () => { location.replace('#/home'); openDrawer('needs', 'tasks'); };

// ─── Plans: every plan with its priority, progress and milestones (plans-view.js) ───
// #/lanes and #/plan/<id> stay as aliases so old links and bookmarks keep working.
setPlansOk((d) => ok(d));
pages.plans = plansPage;
pages.lanes = pages.plans;
pages.plan = pages.plans;

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
const BOARD = [['open', STAGE_LABEL.open], ['active', STAGE_LABEL.active], ['blocked', STAGE_LABEL.blocked], ['done', STAGE_LABEL.done + ', last 7 days']];
const BOARD_MAIN = BOARD.slice(0, 3);
function drawJobs() {
  const R = workFilterKey(state.space);
  const all = prioritizeWork(live.jobs || []);
  const f = filt(R), q = (f.q || '').toLowerCase(), week = Date.now() - 7 * 86400e3;
  const lateFn = j => isLate(j.due, j.stage);
  const base = all.filter(j => (!f.plan || j.plan === f.plan) && (!f.track || trackKey(j.track) === trackKey(f.track)) && (!f.owner || agentName(j.owner) === f.owner)
    && (!q || (j.title + ' ' + j.id + ' ' + (j.last ? j.last.summary : '')).toLowerCase().includes(q)) && !(j.stage === 'done' && j.stage_at && j.stage_at < week));
  const layout = f.layout === 'list' ? 'list' : 'board';
  const mode = WORK_MODES.some(([k]) => k === f.status) ? f.status : 'live';
  const counts = workCounts(base, lateFn);
  const staleFn = j => (live.stale || []).includes(j.id);
  const bmode = BOARD_FILTERS.some(([k]) => k === f.bmode) ? f.bmode : 'all', bcounts = boardCounts(base, lateFn, staleFn);
  const kindOk = j => !f.bkind || (j.stage === 'blocked' && blockerKind(j) === f.bkind);
  const selectedCluster= f.blocker ? blockerClusters(base).find(c=>c.key===f.blocker) : null;
  const selectedIds=selectedCluster?new Set(selectedCluster.jobs.map(j=>j.id)):null;
  const list = (layout === 'list' ? base.filter(j => workMatch(j, mode, lateFn)) : base.filter(j => boardMatch(j, bmode, lateFn, staleFn))).filter(kindOk).filter(j=>!selectedIds||selectedIds.has(j.id));
  const tracks = trackLabels(all.filter(j => !f.plan || j.plan === f.plan).map(j => j.track));
  const setLayout = value => () => { f.layout = value; saveFilt(); drawJobs(); };
  const setMode = k => () => { f.status = k; saveFilt(); drawJobs(); };
  const toggleGroup = () => { f.group = f.group === 'blocker' ? '' : 'blocker'; saveFilt(); drawJobs(); };
  const setBoardMode = k => () => { f.bmode = k; saveFilt(); drawJobs(); };
  const pick = BOARD_MAIN.some(b => b[0] === f.stage) ? f.stage : (list.some(j => j.stage === 'blocked') ? 'blocked' : 'active');
  const setPick = st => () => { f.stage = st; saveFilt(); drawJobs(); };
  const shared = sharedBlockers(list);
  const clusters = blockerClusters(list).filter(c=>c.jobs.length>=3);
  if(f.group===undefined&&clusters.length) f.group='blocker';
  const row = j => { const due = dueState(j, lateFn), note = blockerNote(j), why = j.blocked_on?.note || j.last?.summary || 'No next step recorded.';
    return html`<article class="lmx-work-row" data-key=${j.id}><div><h3 title=${j.title}><a href=${'#/job/' + encodeURIComponent(j.id)}>${j.title}</a></h3><div class="lmx-meta lmx-rowmeta"><span class="lmx-chip lmx-chip--lane">${j.plan || 'No plan'}</span>${j.track ? html`<span>${j.track}</span>` : nothing}<span class="lmx-chip">${j.owner ? agentName(j.owner) : 'Owner not assigned'}</span></div></div>
    <div>${stage(j.stage)}${j.blocked_on?.parked ? html`<span class="lm-badge">Parked</span>` : nothing}${note && shared.has(note) ? html` <span class="lmx-chip" title=${note}>Same blocker ×${shared.get(note)}</span>` : nothing}</div><div class="lmx-why lmx-why-clamp" title=${why}>${why}</div><div class="lmx-due" data-kind=${due.kind}>${due.kind === 'late' ? html`<span class="lmx-flag">${due.text}</span>` : html`<span class="lmx-meta">${due.text}</span>`}${j.stage==='blocked'?html`<span class="lmx-work-copy">${agentDispatchButton(jobDispatchPrompt(j,state.space),'Copy unblock prompt')}</span>`:nothing}</div></article>`; };
  const grouped = () => { const groupedIds=new Set(clusters.flatMap(c=>c.jobs.map(j=>j.id)));
    return html`${clusters.map(c=>clusterBlockerGroup(c,state.space))}${list.filter(j=>!groupedIds.has(j.id)).map(row)}`;
  };
  const unknown = list.filter(j => !BOARD.some(b => b[0] === j.stage));
  const doneList = list.filter(j => j.stage === 'done');
  const map=blockerMap({jobs:base,space:state.space,sel:f.blocker||'',kind:f.bkind||'',setKind:k=>{f.bkind=k;f.blocker='';saveFilt();drawJobs();},pick:k=>{f.blocker=f.blocker===k?'':k;saveFilt();drawJobs();},copy});
  const hasWorkFilter = Boolean(f.plan || f.track || f.owner || f.q || f.blocker || f.bkind);
  const clearWorkFilters = () => { f.plan = f.track = f.owner = f.q = f.blocker = f.bkind = ''; saveFilt(); drawJobs(); };
  renderView('work', ['Work'], html`${head('Work', 'Priorities, owners, and the next step.')}<div class="lmx-work-map-top" data-map-page="work">${map||emptyState('No blocker groups in loaded work.','The map shows recorded blockers. Clear blockers or add details to create groups.')}</div><div class="lmx-work-detail"><div class="lmx-work-toolbar"><div class="lmx-tabsbar" role="group" aria-label="Work layout"><button type="button" aria-pressed=${layout === 'list'} @click=${setLayout('list')}>List</button><button type="button" aria-pressed=${layout === 'board'} @click=${setLayout('board')}>Board</button><a href="#/plans" class="lmx-tabslink">Plans</a></div><div class="lmx-work-links"><a href="#/queue" class="lm-btn lm-btn--secondary" style="text-decoration:none">Inbox</a></div></div>
    <div class="lm-ftbar lmx-filters" role="region" aria-label="Filter work">${selectBox(R, 'plan', 'Plan', uniq(all.map(j=>j.plan)), drawJobs)}${selectBox(R, 'track', 'Track', tracks, drawJobs)}${selectBox(R, 'owner', 'Owner', uniq(all.map(j=>agentName(j.owner))), drawJobs)}${searchBox(R, 'Title or last entry', drawJobs)}${hasWorkFilter ? html`<button type="button" class="lm-ftbar-clear" @click=${clearWorkFilters}>Clear</button>` : nothing}</div>
    ${layout === 'board' ? html`<div class="lmx-filter" role="group" aria-label="Filter the board">${BOARD_FILTERS.map(([k, l]) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(bmode === k)} @click=${setBoardMode(k)}>${l} (${bcounts[k]})</button>`)}</div>` : nothing}
    ${layout === 'list' ? html`<div class="lmx-filter" role="group" aria-label="Filter by status">${WORK_MODES.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String(mode === k)} @click=${setMode(k)}>${l} (${counts[k]})</button>`)}${shared.size ? html`<button type="button" class="lmx-typepill lmx-typepill--toggle" aria-pressed=${String(f.group === 'blocker')} @click=${toggleGroup}>Group by blocker</button>` : nothing}</div>` : nothing}
    ${layout === 'list' ? html`<div class="lmx-work-list">${list.length ? (f.group === 'blocker' && shared.size ? grouped() : keyed(list, j=>j.id, row)) : emptyState('No work matches these filters.', 'Clear a filter or pick another status.')}</div>` : html`
      <div class="lmx-stagechips lmx-phone-only" role="tablist">${BOARD_MAIN.map(b=>html`<button type="button" role="tab" aria-selected=${pick === b[0]} @click=${setPick(b[0])}>${b[1].split(',')[0]} ${list.filter(j=>j.stage===b[0]).length}</button>`)}</div>
      <div class="lmx-board lmx-board--3">${BOARD_MAIN.map(b=>{ const mine=list.filter(j=>j.stage===b[0]); return html`<section class="lmx-boardcol" data-stage=${b[0]} ?data-pick=${pick===b[0]}><h2 class="lmx-colhead">${b[1]} <b>${mine.length}</b></h2><div class="lmx-stack">${keyed(mine,j=>j.id,j=>boardCard(j,'work',{space:state.space}))}${!mine.length ? html`<p class="lmx-meta">None.</p>` : nothing}</div></section>`; })}</div>
      <details class="lmx-donedrawer" ?open=${!!f.doneOpen} @toggle=${e=>{ if(e.target===e.currentTarget && f.doneOpen!==e.target.open){ f.doneOpen=e.target.open; saveFilt(); } }}><summary>Done, last 7 days <b>${doneList.length}</b></summary><div class="lmx-donegrid">${keyed(doneList,j=>j.id,j=>boardCard(j,'work',{space:state.space}))}${!doneList.length ? html`<p class="lmx-meta">None.</p>` : nothing}</div></details>
      ${unknown.length ? html`<section><h2 class="lmx-section-title">Unrecognized stages</h2>${unknown.map(row)}</section>` : nothing}`}
    <p class="lmx-meta">${list.length} matching work items. Milestones are on the Plans tab. Done work from the last seven days appears here.</p></div>`);
}
pages.jobs = async () => { const d = await load('jobs'); if (!ok(d)) return false; live.jobs = d.jobs || []; drawJobs(); return true; };
// #/work/list and #/work/board open Work in that layout (the Plans page links back this way).
pages.work = async (layout) => { if (layout === 'list' || layout === 'board') { const f = filt(workFilterKey(state.space)); f.layout = layout; saveFilt(); history.replaceState(null, '', '#/work'); } return pages.jobs(); };
// Signed out, the sign-in form shows and no panel opens over it.
pages.job = async (id) => { if (!(await pages.jobs())) return; const ds = drawerState(); if (!ds || ds.id !== id) openDrawer('job', id); };

// ─── Agents: "Who is doing what, and are they healthy?" ─────────────
// Walkthroughs: the writer (in the frame) and the player (no admin rail).
pages.write = writerPage;
pages.walk = playerPage;

pages.agents = async () => {
  const [d, lg] = await Promise.all([load('agents'), load('log').catch(() => null)]);
  if (!ok(d)) return;
  const pulseEntries = lg && Array.isArray(lg.entries) ? lg.entries : [];
  const allAgents = d.agents || [];
  const liveN = allAgents.filter((a) => a.seen?.state === 'active').length;
  const quietN = allAgents.filter((a) => a.seen?.state !== 'active').length;
  const noNowN = allAgents.filter((a) => !a.now?.doing).length;
  const pf = filt('agents:' + state.space), counts = agentCounts(allAgents);
  if (pf.selected === undefined && allAgents[0]) pf.selected = allAgents[0].id;
  const draw = () => {
    const view = pf.view === 'table' ? 'table' : 'cards';
    const mode = AGENT_MODES.some(([k]) => k === pf.mode) ? pf.mode : 'all';
    const shown = allAgents.filter((a) => agentMatch(a, mode));
    const avatarOf = (a) => (savedAgentIcon(state.space, a.id) || agentIcon(state.space, a.id))?.src || null;
    const viewToggle = html`<div class="lm-ar-view" role="group" aria-label="Roster layout">
      <button type="button" aria-pressed=${String(view === 'cards')} @click=${() => { pf.view = 'cards'; saveFilt(); draw(); }}>Roster</button>
      <button type="button" aria-pressed=${String(view === 'table')} @click=${() => { pf.view = 'table'; saveFilt(); draw(); }}>Table</button>
    </div>`;
    renderView('agents', ['Agents'], html`
      ${head('Agents', 'Reporting activity, current work, and last recaps across this space.')}
      <div class="lmx-stack" style="gap:16px">
        <div class="lmx-filters"><span class="lmx-meta">${liveN} of ${allAgents.length} wrote in the last 15 minutes. Reporting activity, not runtime reachability.</span><span class="lm-spacer"></span>${view === 'table' ? viewToggle : nothing}<a href="#/slots" class="lm-btn lm-btn--secondary" style="text-decoration:none">Daily slots</a><a href="#/access" class="lm-btn lm-btn--secondary" style="text-decoration:none">Agent access</a></div>
        <section class="lm-kpi-strip" aria-label="Agent metrics">
          <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Total agents</span><span class="lm-kpi-val">${allAgents.length}</span><span class="lm-kpi-sub">in this space</span></div>
          <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Active now</span><span class="lm-kpi-val">${liveN}</span><span class="lm-kpi-sub">wrote in last 15 min</span></div>
          <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Quiet / offline</span><span class="lm-kpi-val">${quietN}</span><span class="lm-kpi-sub">no recent write</span></div>
          <div class="lm-kpi-cell"><span class="lm-kpi-lbl">No Now set</span><span class="lm-kpi-val">${noNowN}</span><span class="lm-kpi-sub">missing current task</span></div>
        </section>

        ${view === 'cards' ? agentRosterCards({
          agents: allAgents,
          filter: pf.arFilter || 'all',
          onFilter: (k) => { pf.arFilter = k; saveFilt(); draw(); },
          query: pf.q || '',
          onQuery: (v) => { pf.q = v; draw(); },
          selected: pf.selected || null,
          onSelect: (id) => { pf.selected = id; draw(); },
          viewToggle,
          space: state.space,
          initialsOf: initials,
          avatarOf,
          renderAction: (a, sp) => agentDispatchButton(agentDispatchPrompt(a, sp)),
        }) : agentsRosterTable({
          agents: shown,
          modes: AGENT_MODES,
          mode,
          counts,
          query: pf.q || '',
          onQuery: (v) => { pf.q = v; draw(); },
          onMode: (k) => { pf.mode = k; saveFilt(); draw(); },
          space: state.space,
          initialsOf: initials,
          avatarOf,
          renderAction: (a, sp) => agentDispatchButton(agentDispatchPrompt(a, sp)),
        })}

        ${fleetPulse({ entries: pulseEntries, agents: allAgents.map((a) => a.id), win: pf.win === 6 ? 6 : 24, sel: pf.lane || '', show: ['active', 'live', 'quiet', 'all'].includes(pf.show) ? pf.show : 'active', setShow: (k) => { pf.show = k; saveFilt(); draw(); }, setWin: (h) => { pf.win = h; saveFilt(); draw(); }, pick: (s) => { pf.lane = s; saveFilt(); draw(); } })}
      </div>
    `);
  };
  draw();
};
pages.agent = async (id) => {
  const d = await load('agent', { id });
  if (!ok(d)) return;
  const pf = filt('agent:' + state.space + ':' + id);
  const draw = () => renderView('agent', [html`<a href="#/agents">Agents</a>`, id], agentProfile({ d, id, pf, space: state.space, redraw: () => { saveFilt(); draw(); } }));
  draw();
};

// ─── Unified Activity / Log & Inspector / Recall ────────────────────
// One consolidated workspace with three clear tabs while preserving #/activity, #/log, and #/recall deep-links.
function activityTabs(active) {
  return html`<nav class="lm-ctabs-list lm-act-tabs" aria-label="Activity views">
    <a class="lm-ctabs-btn" href="#/activity" aria-current=${active === 'feed' ? 'page' : nothing} aria-selected=${String(active === 'feed')}>Feed</a>
    <a class="lm-ctabs-btn" href="#/log" aria-current=${active === 'log' ? 'page' : nothing} aria-selected=${String(active === 'log')}>Log &amp; Inspector</a>
    <a class="lm-ctabs-btn" href="#/recall" aria-current=${active === 'recall' ? 'page' : nothing} aria-selected=${String(active === 'recall')}>Recall</a>
  </nav>`;
}

function drawLog(recallOnly = false) {
  const all = live.log || [], f = filt('log'), q = (f.q || '').toLowerCase(), rc = live.recall;
  const list = all.filter((e) => (f.allEvents || e.group !== 'system') && (!f.where || String(e.where || '').indexOf(f.where + ':') === 0 || e.where === f.where) && (!f.agent || agentName(e.by) === f.agent) && (!f.kind || e.group === f.kind) && (!q || String(e.summary || '').toLowerCase().includes(q)));
  const places = ['job', 'channel', 'agent'].concat(uniq(all.map((e) => (/^channel:/.test(e.where || '') ? e.where : null))));
  let rq = rc ? rc.q : '';
  const grouped = groupUpdates(list);
  const mode = groupByMode(f.group), terms = rc ? matchTerms(rc.q) : [];
  const sel = (live.logSel && (all.find((e) => entryKey(e) === entryKey(live.logSel)) || live.logSel)) || null, selKey = sel ? entryKey(sel) : '';
  const pick = (e) => { live.logSel = e; drawLog(false); if (matchMedia('(max-width:639px)').matches) requestAnimationFrame(() => document.querySelector('.lmx-inspector')?.scrollIntoView({ block: 'start' })); };
  const openOriginal = (r) => {
    live.logSel = all.find((e) => String(e.trail || '') === r.trail && Number(e.ts) === r.ts) || { ts: r.ts, kind: r.kind, summary: r.summary, trail: r.trail || undefined, where: r.from, by: r.by || undefined, group: all.find((e) => e.kind === r.kind)?.group };
    f.where = f.agent = f.kind = f.q = ''; f.allEvents = true; saveFilt(); live.recall = null;
    if (location.hash !== '#/log') location.hash = '#/log'; else drawLog(false);
  };
  const activeTab = recallOnly ? 'recall' : 'log';
  const hasLogFilter = Boolean(f.where || f.agent || f.kind || f.q);
  const clearLogFilters = () => { f.where = f.agent = f.kind = f.q = ''; saveFilt(); drawLog(false); };

  renderView(activeTab === 'recall' ? 'recall' : 'log', ['Activity', activeTab === 'recall' ? 'Recall' : 'Log & Inspector'], html`
    <header class="lmx-pageheader">
      <div>
        <span class="lm-eyebrow">${activeTab === 'recall' ? 'Search shared memory across the space' : 'Raw event stream · inspector · replay scrubber'}</span>
        <h1>Activity</h1>
      </div>
      <div class="lmx-pageheader-links">${activityTabs(activeTab)}</div>
    </header>

    ${activeTab === 'recall' ? html`
      <form class="lm-recall-bar" role="search" @submit=${(e) => { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(e.target.q.value.trim()); }}>
        <label class="lmx-chat-sr" for="recall-query">Recall query</label>
        <input id="recall-query" class="lm-input" name="q" .value=${liveDir(rq)} placeholder="Search shared memory: what did we decide about…">
        <button class="lm-btn lm-btn--primary">Recall</button>
      </form>
      ${rc ? html`<section class="lm-panel lmx-recall-panel" aria-label="Recall results">
        <div class="lm-panel-head"><h2 class="lm-title-3" style="margin:0;font-size:14px">Recall: “${rc.q}”</h2><span class="lm-spacer"></span><span class="lmx-meta">${(rc.results || []).length} ${(rc.results || []).length === 1 ? 'result' : 'results'}</span></div>
        ${recallExplainer()}
        ${(rc.results || []).length ? (rc.results || []).map((r) => recallCard(r, terms, openOriginal)) : html`<p class="lmx-meta" style="padding:14px 16px">No matches. Try fewer or different words.</p>`}
      </section>` : html`<section class="lm-plain-panel">
        <h2 style="margin:0;font-size:14px;color:var(--text)">Search older entries beyond the live window</h2>
        ${recallExplainer()}
        <p class="lmx-meta">Type any keyword, decision topic, job name, or agent name above. Clicking <strong>Open original entry</strong> jumps directly into the Log &amp; Inspector view.</p>
      </section>`}
    ` : html`
      <details class="lmx-filter-fold" ?open=${!matchMedia('(max-width:639px)').matches}><summary>Filters</summary><div class="lm-ftbar" role="region" aria-label="Filter log">
        <div class="lmx-tabsbar" role="group" aria-label="Activity detail">
          <button type="button" aria-pressed=${!f.allEvents} @click=${() => { f.allEvents = false; saveFilt(); drawLog(false); }}>Work updates</button>
          <button type="button" aria-pressed=${!!f.allEvents} @click=${() => { f.allEvents = true; saveFilt(); drawLog(false); }}>All events</button>
        </div>
        ${selectBox('log', 'where', 'Where', places, () => drawLog(false))}
        ${selectBox('log', 'agent', 'Who', uniq(all.map((e) => agentName(e.by))), () => drawLog(false))}
        ${selectBox('log', 'kind', 'Kind', uniq(all.map((e) => e.group)), () => drawLog(false))}
        ${searchBox('log', 'Filter entries…', () => drawLog(false))}
        ${hasLogFilter ? html`<button type="button" class="lm-ftbar-clear" @click=${clearLogFilters}>Clear</button>` : nothing}
      </div></details>

      <div class="lm-log-subbar">
        <div class="lmx-groupbar" style="margin:0"><span class="lmx-meta">Group by</span>${groupControl(mode, (k) => { f.group = k; saveFilt(); drawLog(false); })}</div>
        <form class="lm-inline-recall" role="search" @submit=${(e) => { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(e.target.q.value.trim()); }}>
          <input class="lm-ftbar-search" name="q" .value=${liveDir(rq)} placeholder="Quick Recall search…">
          <button class="lm-btn lm-btn--secondary">Recall</button>
        </form>
      </div>

      ${timeScrubber({ entries: all, t: f.scrubT ?? null, scrub: (t) => { f.scrubT = t; drawLog(false); } })}
      <div class="lmx-log-layout${sel ? ' has-sel' : ''}">${inspector({ sel, all, close: () => { live.logSel = null; drawLog(false); } })}<section class="lm-panel lmx-log-list" style="padding:8px 16px 16px">${mode !== 'time' || f.allEvents ? (list.length ? logList(logRows(list, mode), selKey, pick) : emptyState('No entries match.', 'Clear a filter. This is a bounded read window.')) : html`${grouped.invalid.length ? html`<p role="alert">${grouped.invalid.length} updates have invalid or future timestamps. Inspect All events for their source records.</p>` : nothing}${grouped.groups.length ? grouped.groups.map(g => html`<section class="lmx-activity-group"><h2 class="lmx-section-title">${g.where.startsWith('job:') ? html`<a href=${'#/job/' + encodeURIComponent(g.where.slice(4))}>${g.where}</a>` : g.where}</h2>${logList(g.entries.map((e) => ({ type: 'entry', e })), selKey, pick)}</section>`) : emptyState('No work updates match.', 'Clear a filter or inspect All events. This is a bounded read window.')}`}<p class="lmx-meta">${list.length} of ${all.length} recent entries.${mode === 'shift' || (mode === 'time' && f.allEvents) ? ' Shift markers come from entry times: a new writer or a gap over 30 minutes starts a shift.' : ''}</p></section></div>
    `}
  `);
}
// ─── Activity Feed: newest first, grouped by day, Show older cursor ──
const ACTIVITY_PAGE = 50;
function drawActivity() {
  const all = live.log || [], f = filt('activity:' + state.space), now = Date.now();
  const agents = uniq(all.map((e) => agentName(e.by)).filter(Boolean)).sort();
  if (f.agent && !agents.includes(f.agent)) f.agent = '';
  const list = filterActivity(all, { agent: f.agent || '', kind: f.kind || '' }, agentName);
  const kinds = Object.fromEntries(KIND_GROUPS.map(([k]) => [k, all.filter((e) => (e.group || 'system') === k && (!f.agent || agentName(e.by) === f.agent)).length]));
  const shown = list.slice(0, Math.max(ACTIVITY_PAGE, Number(f.shown) || ACTIVITY_PAGE));
  const mode = f.view === 'compact' ? 'compact' : 'timeline';
  const set = (key, value) => () => { f[key] = value; f.shown = ACTIVITY_PAGE; saveFilt(); drawActivity(); };
  const row = (e) => html`<li class="lmx-activity-row" data-k=${e.group || 'system'}><time datetime=${new Date(Number(e.ts)).toISOString()} title=${fullTime(e.ts)}>${clock24(e.ts)}</time>
    <span class="lmx-kind-chip" data-k=${e.group || 'system'}>${e.kind}</span>${agent(e.by)}
    <div class="lmx-activity-main"><p>${textWithIds(e.summary)}</p><span class="lmx-feed-meta">${placeLink(e.where) ? html`<a href=${placeLink(e.where).href}>${placeLink(e.where).label}</a>` : html`<span>${e.where || 'No place recorded'}</span>`}${e.trail ? idChip(e.trail, 'trail') : nothing}<span title=${fullTime(e.ts)}>${relTime(e.ts, now)}</span></span></div></li>`;
  const hasActFilter = Boolean(f.agent || f.kind);
  renderView('activity', ['Activity'], html`
    <header class="lmx-pageheader">
      <div><span class="lm-eyebrow">Every entry · newest first</span><h1>Activity</h1></div>
      <div class="lmx-pageheader-links">${activityTabs('feed')}</div>
    </header>
    <div class="lm-ftbar" role="region" aria-label="Filter activity">
      <label class="lmx-f"><span>Agent</span><select class="lm-select" aria-label="Filter by agent" @change=${(e) => set('agent', e.target.value)()}><option value="">All agents</option>${agents.map((n) => html`<option ?selected=${n === f.agent}>${n}</option>`)}</select></label>
      <div class="lm-ftbar-pills" role="group" aria-label="Filter by kind">
        <button type="button" class="lm-ftbar-pill" aria-pressed=${String(!f.kind)} @click=${set('kind', '')}>All <span>${f.agent ? all.filter((e) => agentName(e.by) === f.agent).length : all.length}</span></button>
        ${KIND_GROUPS.map(([k, l]) => html`<button type="button" class="lm-ftbar-pill" data-k=${k} aria-pressed=${String(f.kind === k)} ?disabled=${!kinds[k] && f.kind !== k} @click=${set('kind', f.kind === k ? '' : k)}>${l} <span>${kinds[k]}</span></button>`)}
      </div>
      <div class="lm-ftbar-right">
        ${hasActFilter ? html`<button type="button" class="lm-ftbar-clear" @click=${() => { f.agent = ''; f.kind = ''; f.shown = ACTIVITY_PAGE; saveFilt(); drawActivity(); }}>Clear</button>` : nothing}
        <div class="lm-ar-view" role="group" aria-label="Activity display mode">
          <button type="button" aria-pressed=${String(mode === 'timeline')} @click=${() => { f.view = 'timeline'; saveFilt(); drawActivity(); }}>Timeline</button>
          <button type="button" aria-pressed=${String(mode === 'compact')} @click=${() => { f.view = 'compact'; saveFilt(); drawActivity(); }}>Compact</button>
        </div>
      </div>
    </div>
    ${shown.length ? dayGroups(shown, now).map((g) => mode === 'timeline' ? activityTimelineGroup(g, { now }) : html`<section class="lmx-activity-day" aria-label=${g.label}><h2 class="lmx-activity-dayhead">${g.label} <span class="lmx-meta">${g.entries.length}</span></h2><ol class="lmx-activity-list">${repeat(g.entries, entryKey, row)}</ol></section>`) : emptyState(all.length ? 'No entries match these filters.' : 'No activity yet.', all.length ? 'Pick All agents or All kinds.' : 'Entries appear here as agents write.')}
    <div class="lmx-activity-foot">${list.length > shown.length ? html`<button type="button" class="lm-btn lm-btn--secondary" @click=${() => { f.shown = shown.length + ACTIVITY_PAGE; saveFilt(); drawActivity(); }}>Load ${Math.min(ACTIVITY_PAGE, list.length - shown.length)} more</button>` : nothing}${list.length <= shown.length && live.logNext ? html`<button type="button" class="lm-btn lm-btn--secondary" ?disabled=${!!live.logBusy} @click=${showOlder}>${live.logBusy ? 'Loading older entries' : 'Show older'}</button>` : nothing}<span class="lmx-meta" role="status">${shown.length} of ${list.length} shown.${live.logErr ? ' ' + live.logErr : live.logNext ? ' Older entries are available.' : live.logIndexed ? ' This is the oldest indexed entry. Use ' : ' This screen reads the latest ' + all.length + ' entries. Use '}${live.logNext && !live.logErr ? nothing : html`<a href="#/recall">Recall</a> for older ones.`}</span></div>`);
}
async function showOlder() {
  if (live.logBusy || !live.logNext) return;
  const route = location.hash, space = state.space;
  live.logBusy = true; live.logErr = ''; drawActivity();
  const d = await load('log', { cursor: live.logNext });
  live.logBusy = false;
  if (location.hash !== route || state.space !== space) return; // the viewer left Activity while the page loaded
  if (d.__status === 401) { ok(d); return; }
  // Keep the loaded entries on screen. The shared error page would replace them.
  if (d.__status !== 200) { live.logErr = 'Older entries could not load. Try again.'; drawActivity(); return; }
  const f = filt('activity:' + state.space);
  live.log = appendOlder(live.log, d.entries); live.logNext = olderCursor(d);
  f.shown = (Number(f.shown) || ACTIVITY_PAGE) + ACTIVITY_PAGE; saveFilt();
  drawActivity();
}
pages.activity = async () => { const d = await load('log'); if (!ok(d)) return; live.log = d.entries || []; live.logNext = olderCursor(d); live.logIndexed = d.coverage?.source === 'index'; live.logBusy = false; live.logErr = ''; observeTelemetry(state.space,{activity:{value:Array.isArray(d.entries)?d.entries.length:null}}); drawActivity(); };
pages.log = async () => { live.recall = null; const d = await load('log'); if (!ok(d)) return; live.log = d.entries || []; observeTelemetry(state.space,{activity:{value:Array.isArray(d.entries)?d.entries.length:null}}); drawLog(false); };
pages.recall = async (q) => {
  const query = q || '';
  const [l, r] = await Promise.all([load('log'), query ? load('recall', { q: query }) : Promise.resolve({ results: [] })]);
  if (!ok(l)) return;
  live.log = l.entries || []; observeTelemetry(state.space,{activity:{value:Array.isArray(l.entries)?l.entries.length:null}}); live.recall = query ? { q: query, results: r.results || [] } : null; drawLog(true);
};
pages.channels = async (id) => { filt('log').where = id ? 'channel:' + id : 'channel'; saveFilt(); return pages.log(); };

// Knowledge: Decisions & Shared Channels — why choices were made and where agents coordinate.
pages.knowledge = async () => {
  const [d, c, fleet] = await Promise.all([load('decisions'), load('channels'), load('agents').catch(() => null)]);
  if (!ok(d) || !ok(c)) return;
  const waiting = d.waiting || [], decided = d.decided || [], channels = c.channels || [];
  const fleetAgents = Array.isArray(fleet?.agents) ? fleet.agents : [];
  const activeAgents = fleetAgents.filter((a) => a.seen?.state === 'active').length;
  const pf = filt('knowledge:' + state.space);
  const byAgent = new Map();
  decided.forEach((row) => { const id = String(row.ask?.by || 'unknown'); byAgent.set(id, (byAgent.get(id) || 0) + 1); });
  const decisionAgents = [...byAgent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const exportAudit = () => copy(['LogMem settled decisions', `Space: ${state.space}`, ...decided.map(({ ask, answer }) => `- ${ask?.summary || 'Untitled decision'} | ${answer?.payload?.verdict || 'outcome unavailable'} | ${agentName(answer?.by)} | ${answer?.ts || 'time unavailable'} | trail ${ask?.trail || 'unavailable'}`)].join('\n'));
  observeTelemetry(state.space, { decisions: { value: Array.isArray(d.waiting) ? d.waiting.length : null } });

  const defaultTab = waiting.length ? 'waiting' : decided.length ? 'settled' : 'channels';
  const draw = () => {
    const tab = ['waiting', 'settled', 'channels'].includes(pf.tab) ? pf.tab : defaultTab;
    const setTab = (k) => { pf.tab = k; saveFilt(); draw(); };
    const q = String(pf.q || '').trim().toLowerCase();
    const filteredDecided = decided.filter(({ ask, answer }) => {
      if (pf.historyAgent && String(ask?.by || 'unknown') !== pf.historyAgent) return false;
      if (!q) return true;
      return [ask?.summary, ask?.by, answer?.summary, answer?.by, answer?.payload?.verdict].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    const histCard = ({ ask: a, answer }) => {
      const v = verdictLabel(answer?.payload?.verdict);
      return html`<article class="lm-kn-card lmx-hist-card" data-agent=${String(a.by || 'unknown')} data-key=${'decision:' + a.trail}>
        <div class="lmx-histhead">
          <h3>${a.summary}</h3>
          ${v ? html`<span class="lmx-verdict" data-v=${answer.payload.verdict}>${v}</span>` : nothing}
        </div>
        <div class="lmx-meta">${agentName(answer.by)} · ${answer.ts ? ago(answer.ts) : 'Timestamp unavailable'} <button type="button" class="lmx-idchip" title=${'Copy ' + a.trail} @click=${() => copy(a.trail)}>trail:…${String(a.trail).slice(-8)}</button></div>
        ${entries([answer])}
        <a class="lm-kn-link" href=${'#/discussion/decision/' + encodeURIComponent(a.trail)}>Source comments →</a>
      </article>`;
    };

    const { waiting: hot, clear } = splitDecisionRows(decisionGraph(waiting, decided));
    renderView('knowledge', ['Knowledge'], html`
      <header class="lmx-pageheader">
        <div>
          <span class="lm-eyebrow">Decision log &amp; shared channels</span>
          <h1>Knowledge</h1>
          <p class="lmx-meta" style="margin:4px 0 0">The institutional memory of this space: open approvals, settled decisions with audit trails, and shared agent channels.</p>
        </div>
        <div class="lmx-cockpit-links"><a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/recall">Search shared memory</a><a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/channels/fleet-truth">Fleet truth</a></div>
      </header>

      <section class="lm-kpi-strip" aria-label="Knowledge summary">
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'waiting')} @click=${() => setTab('waiting')}><span class="lm-kpi-lbl">Waiting decisions</span><span class="lm-kpi-val">${waiting.length}</span><span class="lm-kpi-sub">awaiting sign-off</span></button>
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'settled')} @click=${() => setTab('settled')}><span class="lm-kpi-lbl">Settled archive</span><span class="lm-kpi-val">${decided.length}</span><span class="lm-kpi-sub">recorded verdicts</span></button>
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'channels')} @click=${() => setTab('channels')}><span class="lm-kpi-lbl">Shared channels</span><span class="lm-kpi-val">${channels.length}</span><span class="lm-kpi-sub">topic streams</span></button>
        <div class="lm-kpi-cell"><span class="lm-kpi-lbl">Active writers</span><span class="lm-kpi-val">${fleetAgents.length ? `${activeAgents}/${fleetAgents.length}` : '—'}</span><span class="lm-kpi-sub">wrote in last 15 min</span></div>
      </section>

      <section class="lm-ctabs" aria-label="Knowledge sections">
        <div class="lm-ctabs-bar">
          <div class="lm-ctabs-list" role="tablist" aria-label="Knowledge tabs">
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'waiting')} @click=${() => setTab('waiting')}>Waiting Decisions <span class="lm-ctabs-count">${waiting.length}</span></button>
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'settled')} @click=${() => setTab('settled')}>Settled Archive <span class="lm-ctabs-count">${decided.length}</span></button>
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'channels')} @click=${() => setTab('channels')}>Shared Channels <span class="lm-ctabs-count">${channels.length}</span></button>
          </div>
          <div class="lm-ar-head-right">
            <button type="button" class="lm-btn lm-btn--secondary" @click=${exportAudit} ?disabled=${!decided.length}>Copy decision audit</button>
          </div>
        </div>

        <div class="lm-ctabs-panel">
          ${tab === 'waiting' ? html`
            ${hot.length || clear.length ? html`<div class="lm-kn-strip">
              ${hot.map((r) => html`<span class="lm-kn-agentchip is-hot"><strong>${agentName(r.agent)}</strong> <span>${r.pending} waiting</span></span>`)}
              ${clear.map((r) => html`<span class="lm-kn-agentchip"><strong>${agentName(r.agent)}</strong> <span>${r.decided} settled</span></span>`)}
            </div>` : nothing}
            ${waiting.length
              ? html`<div class="lmx-stack">${keyed(waiting, a => a.trail, a => canAnswerDecision(a, { person: d.person, canApprove: !state.customer || Boolean(d.permissions?.approve) }) ? askCard(a) : html`<article class="lm-kn-card"><h3>${a.summary}</h3><p class="lmx-meta">${a.to ? 'Requested from ' + agentName(a.to) : 'Approval permission required'}. This request is read-only here.</p><p>${a.payload?.action || 'Open the source for details.'}</p><a class="lm-kn-link" href=${'#/discussion/decision/' + encodeURIComponent(a.trail)}>Source comments →</a></article>`)}</div>`
              : emptyState('No waiting decisions right now.', 'When an agent asks for approval via logmem_ask, it appears here and in Inbox.')}
          ` : nothing}

          ${tab === 'settled' ? html`
            <div class="lm-ftbar" role="region" aria-label="Filter settled decisions">
              <div class="lm-ftbar-pills" role="group" aria-label="Filter settled decisions by agent">
                <button type="button" class="lm-ftbar-pill" aria-pressed=${String(!pf.historyAgent)} @click=${() => { pf.historyAgent = ''; saveFilt(); draw(); }}>All agents <span>${decided.length}</span></button>
                ${decisionAgents.map(([id, count]) => html`<button type="button" class="lm-ftbar-pill" aria-pressed=${String(pf.historyAgent === id)} @click=${() => { pf.historyAgent = pf.historyAgent === id ? '' : id; saveFilt(); draw(); }}>${agentName(id)} <span>${count}</span></button>`)}
              </div>
              <div class="lm-ftbar-right">
                <label class="lmx-chat-sr" for="knowledge-search">Search decisions</label>
                <input id="knowledge-search" type="search" class="lm-ftbar-search" placeholder="Search settled decisions…" .value=${pf.q || ''} @input=${(e) => { pf.q = e.currentTarget.value; draw(); }}>
                ${pf.historyAgent || pf.q ? html`<button type="button" class="lm-ftbar-clear" @click=${() => { pf.historyAgent = ''; pf.q = ''; saveFilt(); draw(); }}>Clear</button>` : nothing}
              </div>
            </div>
            ${filteredDecided.length
              ? groupDecisions(filteredDecided).map((g) => html`<section class="lm-kn-group"><h3 class="lm-kn-dayhead">${g.label} <span class="mono">${g.items.length}</span></h3><div class="lm-kn-grid">${g.items.map(histCard)}</div></section>`)
              : emptyState(decided.length ? 'No decisions match this filter.' : 'No settled decisions yet.', decided.length ? 'Clear the search or pick All agents.' : 'Settled decisions appear once an approval request is answered.')}
          ` : nothing}

          ${tab === 'channels' ? html`
            ${channels.length
              ? html`<div class="lm-kn-grid">${channels.map((ch) => html`<article class="lm-kn-card">
                  <div class="lmx-histhead">
                    <h3><a href=${'#/channels/' + encodeURIComponent(ch.id)}>#${ch.id}</a></h3>
                    ${ch.id === 'fleet-truth' ? html`<span class="lm-badge lm-badge--brand">Truth Board</span>` : nothing}
                  </div>
                  <p class="lm-kn-sum">${ch.last?.summary || 'No recent entry was returned.'}</p>
                  <div class="lm-kn-foot">
                    <span class="lmx-meta">${ch.last?.by ? agentName(ch.last.by) : 'Author unavailable'}${ch.last?.ts ? ' · ' + ago(ch.last.ts) : ''}</span>
                    <a class="lm-kn-link" href=${'#/channels/' + encodeURIComponent(ch.id)}>${ch.id === 'fleet-truth' ? 'Open board →' : 'Read channel →'}</a>
                  </div>
                </article>`)}</div>`
              : emptyState('No shared channels yet.', 'Topic streams appear here when agents post notes to a channel.')}
          ` : nothing}
        </div>
      </section>
      <p class="lmx-meta">Decisions come from a bounded source window. Use <a href="#/recall">Recall</a> to search older shared memory.</p>
    `);
  };
  draw();
};

// ─── Admin pages ─────────────────────────────────────────────────────
pages.settings = async () => {
  const d = await load('settings');
  if (!ok(d)) return;
  const pingOk = Number.isFinite(Number(d.ping_ms)), spaces = Array.isArray(d.mirror_spaces) ? d.mirror_spaces : [];
  // Read-only chip, not a switch: this page cannot change these settings.
  const sw = (label, on, text) => html`<div class="lmx-control-row"><span>${label}</span><span class="lmx-rochip" data-on=${String(on)}>${text}</span><span class="lm-badge lm-badge--info">Planned</span></div>`;
  const control = (title, status, body) => html`<section class="lmx-control"><header><h2>${title}</h2>${status || nothing}</header><div class="lmx-control-body">${body}</div></section>`;
  renderView('settings', ['Settings'], html`${head('Settings', 'Connections and administration for this space.')}${viewOnlyNote(SETTINGS_NOTE)}
    <nav class="lmx-adminbar" aria-label="Administration">${ADMIN.filter(n=>n[0]!=='settings').map(n=>html`<a href=${n[3] || '#/'+n[0]}>${n[1]}</a>`)}<button type="button" @click=${signOut}>Sign out</button></nav>
    <div class="lmx-controls">
    ${control('Space', html`<span class="lm-badge lm-badge--brand mono">${d.space}</span>`, html`<div class="lmx-control-row"><span>Agent keys</span><b class="mono">${typeof d.keys === 'object' ? JSON.stringify(d.keys) : d.keys}</b></div>`)}
    ${control('Storage', pingOk ? html`<span class="lmx-live" data-s="ok"><i class="lmx-pulse" aria-hidden="true"></i>Connected</span>` : html`<span class="lmx-live" data-s="down">Unavailable</span>`, html`<div class="lmx-control-row"><span>Latency</span><b class="mono">${pingOk ? 'PING ' + d.ping_ms + ' ms' : 'No reply'}</b></div><p class="lmx-meta">Your Redis, over the deploy’s bridge connection.</p>`)}
    ${control('ACMI compatibility', nothing, html`${sw('Compatibility mode', !!d.compat, d.compat ? 'On' : 'Off')}${sw('Mirror to ACMI', !!d.mirror, d.mirror ? 'On for ' + (spaces.join(', ') || 'this space') : 'Off')}<p class="lmx-meta">These show the deploy’s current settings. They cannot be changed from this page.</p>`)}
    </div>`);
};
// ─── Daily slots: who ran their scheduled shifts, by day ───
const SLOT_STATE = { pass: ['completed', 'Pass'], partial: ['in-progress', 'Partial'], failed: ['failed', 'Failed'], missed: ['blocked', 'Missed'], pending: ['pending', 'Pending'], disabled: ['deferred', 'Disabled'] };
const SLOT_ORDER = ['morning', 'midday', 'closeout'];
const slotCell = (cell) => {
  const [ic, label] = SLOT_STATE[cell?.state] || ['unknown', cell?.state || 'Unknown'];
  const n = (cell?.attempts || []).length;
  return html`<td>${decision(ic, label)}${n ? html` <span class="muted mono" style="font-size:12px">${n} ${n === 1 ? 'run' : 'runs'}</span>` : nothing}</td>`;
};
pages.slots = async (date) => {
  const [d, ag] = await Promise.all([load('slots', date ? { date } : {}), load('agents')]);
  if (!ok(d)) return;
  const pf = filt('slots:' + state.space);
  const rows = (d.agents || []).map((a) => html`<tr><td><a href=${'#/agent/' + encodeURIComponent(a.agent)}>${agentName(a.agent)}</a></td>${SLOT_ORDER.map((s) => slotCell(a.slots && a.slots[s]))}</tr>`);
  const draw = () => renderView('slots', ['Agents', 'Daily slots'], html`${head('Daily slots', 'Review shift timelines and coordination receipts by day. An empty slot past its window reads Missed.')}
    <div class="lmx-filters"><label>Run date <input type="date" class="lm-input" .value=${d.date || ''} @change=${(e) => { if (e.target.value && e.target.validity.valid) location.hash = '#/slots/' + encodeURIComponent(e.target.value); }}></label><span class="lmx-meta">${(d.agents || []).length} agents · America/New_York</span><span class="lm-spacer"></span><a href="#/audit" class="lm-btn lm-btn--secondary">Coordination audit</a><a href="#/agents" class="lm-btn lm-btn--secondary">Agents</a></div>
    ${shiftTimelineSection({ agents: ag?.agents || [], pf, redraw: () => { saveFilt(); draw(); } })}
    <p class="muted">Receipts do not prove an active runner or a configured schedule.</p>
    ${rows.length ? table(['Agent', 'Morning', 'Midday', 'Closeout'], rows) : emptyState('No agents yet.', 'Slots appear once agents are in this space.')}`);
  draw();
};
async function auditPage(route = 'audit') {
  const d = await load('audit');
  if (!ok(d)) return;
  const pf = filt('health:' + state.space);
  const observedAudit = d.days?.at(-1);
  observeTelemetry(state.space, { mirror: { value: d.source_status?.audit === 'error' || observedAudit?.mirror_checked === false ? null : typeof observedAudit?.mirror_mismatches === 'number' ? observedAudit.mirror_mismatches : null, label: d.source_status?.audit === 'error' ? 'Unavailable' : observedAudit?.mirror_checked === false ? 'Not enabled' : 'Unknown' } });
  const draw = () => {
    const g = d.gate || {}, last7 = (d.days || []).slice(-7), earliest = earliestPass(d.days, g);
    const strip = Array.from({ length: 7 }, (_, i) => { const x = last7[i - (7 - last7.length)]; const st = !x ? 'background:var(--surface-sunken);color:var(--text-subtle)' : x.pass ? 'background:var(--success-subtle);color:var(--success)' : 'background:var(--danger-subtle);color:var(--danger)'; return html`<div style=${'display:flex;flex-direction:column;align-items:center;padding:10px 4px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;' + st}><span>${x ? x.date.slice(5) : '—'}</span><span>${x ? (x.paused ? 'PAUSED' : x.pass === true ? 'PASS' : x.pass === false ? 'FAIL' : 'UNKNOWN') : '—'}</span></div>`; });
    const rows = auditDays(d.days || [], pf.auditFilter || 'all');
    const q = d.pending || { items: [], total: 0, counts: {} };
    const c = q.counts || {};
    const queueItems = q.items || [], filtered = healthQueueItems(queueItems, pf.queueFilter || 'all');
    const activeQueue = filtered.filter(i => !isStaleTicket(i));
    const staleQueue = filtered.filter(i => isStaleTicket(i));
    const runs = d.slots || [];
    const runState = (slot) => {
      const value = slot?.state || 'unknown';
      const tone = value === 'pass' ? 'success' : ['failed', 'missed'].includes(value) ? 'danger' : 'neutral';
      return html`<span class=${'lm-badge lm-badge--' + tone}>${value}</span><span class="lmx-meta"> · ${num(slot?.attempts?.length || 0)} attempts</span>`;
    };
    const recordedRuns = runs.filter(a => Object.values(a.slots || {}).some(slot => slot?.attempts?.length));
    const latestAudit = d.days?.at(-1);
    const mirrorValue = d.source_status?.audit === 'error' ? 'Unavailable' : !latestAudit ? 'Unknown' : latestAudit.mirror_checked === false ? 'Not enabled' : latestAudit.mirror_mismatches;
    const runRows = recordedRuns.map((a) => html`<tr><td><a href=${'#/agent/' + encodeURIComponent(a.agent)}>${agentName(a.agent)}</a></td><td>${a.date || 'Unknown date'}</td>${['morning', 'midday', 'closeout'].map((slot) => html`<td>${runState(a.slots?.[slot])}</td>`)}</tr>`);

    const defaultTab = route === 'audit' ? 'audit' : 'requests';
    const tab = ['requests', 'audit', 'receipts'].includes(pf.tab) ? pf.tab : defaultTab;
    const setTab = (k) => { pf.tab = k; saveFilt(); draw(); };
    const selectQueue = (filter) => { pf.tab = 'requests'; pf.queueFilter = filter; saveFilt(); draw(); };
    const selectAudit = (filter) => { pf.tab = 'audit'; pf.auditFilter = filter; saveFilt(); draw(); };

    renderView(route, [route === 'health' ? 'Health' : 'Audit'], html`
      <header class="lmx-pageheader">
        <div>
          <span class="lm-eyebrow">Updated ${d.generated_at ? hhmm(d.generated_at) : 'with this request'} · ${d.coverage || 'partial'} index coverage</span>
          <h1>${route === 'health' ? 'Health' : 'Audit'}</h1>
          <p class="lmx-meta" style="margin:4px 0 0">${route === 'health' ? 'Missing receipts, overdue handoffs, and daily coordination audits in one view.' : 'The daily check that nothing was lost or left hanging.'}</p>
        </div>
        <div class="lmx-cockpit-links">
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/channels/fleet-truth">Fleet truth</a>
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/slots">Daily slots</a>
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/queue">Inbox</a>
        </div>
      </header>
      ${route === 'audit' ? viewOnlyNote(AUDIT_NOTE) : nothing}

      <section class="lm-kpi-strip" aria-label="Coordination health summary">
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'requests' && (pf.queueFilter || 'all') === 'all')} @click=${() => selectQueue('all')}><span class="lm-kpi-lbl">Requests waiting</span><span class="lm-kpi-val">${num(q.total)}</span><span class="lm-kpi-sub">${num(c.handoffs)} handoffs · ${num(c.directed)} directed</span></button>
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'requests' && pf.queueFilter === 'overdue')} @click=${() => selectQueue('overdue')}><span class="lm-kpi-lbl">Overdue responses</span><span class="lm-kpi-val">${num(c.overdue)}</span><span class="lm-kpi-sub">past reply deadline</span></button>
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'receipts')} @click=${() => setTab('receipts')}><span class="lm-kpi-lbl">Saved checks</span><span class="lm-kpi-val">${d.source_status?.receipts === 'error' ? 'Err' : recordedRuns.length}</span><span class="lm-kpi-sub">agents with receipts</span></button>
        <button type="button" class="lm-kpi-cell lm-ft-kpi-btn" aria-pressed=${String(tab === 'audit' && pf.auditFilter === 'mirror')} @click=${() => selectAudit('mirror')}><span class="lm-kpi-lbl">Mirror gaps</span><span class="lm-kpi-val">${mirrorValue ?? '—'}</span><span class="lm-kpi-sub">latest audit window</span></button>
      </section>

      <section class="lm-ctabs" aria-label="Health & Audit views">
        <div class="lm-ctabs-bar">
          <div class="lm-ctabs-list" role="tablist" aria-label="Health sections">
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'requests')} @click=${() => setTab('requests')}>Waiting Requests <span class="lm-ctabs-count">${num(q.total)}</span></button>
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'audit')} @click=${() => setTab('audit')}>7-Day Gate &amp; Audit <span class="lm-ctabs-count">${(d.days || []).length}</span></button>
            <button type="button" role="tab" class="lm-ctabs-btn" aria-selected=${String(tab === 'receipts')} @click=${() => setTab('receipts')}>Saved Receipts <span class="lm-ctabs-count">${recordedRuns.length}</span></button>
          </div>
          <a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/queue">Open Inbox →</a>
        </div>

        <div class="lm-ctabs-panel">
          ${tab === 'requests' ? html`
            <div class="lm-ftbar" id="health-queue">
              <div class="lm-ftbar-pills" role="group" aria-label="Request filters">
                ${[['all', 'All', queueItems.length], ['overdue', 'Overdue', queueItems.filter(i => overdueRequest(i)).length], ['unindexed', 'Not indexed', queueItems.filter(unindexedRequest).length]].map(([value, label, count]) => html`<button type="button" class="lm-ftbar-pill" aria-pressed=${String((pf.queueFilter || 'all') === value)} @click=${() => selectQueue(value)}>${label} <span>${count}</span></button>`)}
              </div>
              <span class="lmx-meta">${filtered.length} matching of ${queueItems.length} loaded (${num(q.total)} total)</span>
            </div>
            ${d.coverage !== 'full' ? html`<div class="lmx-coverage-note"><strong>Partial index coverage:</strong> combines indexed requests with recent source handoffs. Run history indexing before treating this as the complete backlog.</div>` : nothing}
            ${activeQueue.length ? html`<div class="lmx-health-requests">${activeQueue.map(item => healthRequestRow(item, state.space))}</div>` : emptyState(queueItems.length ? (staleQueue.length ? 'Active queue is clear; older overdue requests are shown below.' : 'No loaded records match this filter.') : 'No open records were returned.', queueItems.length ? 'Choose another filter.' : 'No unanswered handoffs, seats, or directed requests were found.')}
            ${staleQueue.length ? html`<section class="lmx-stack" aria-label="Older overdue requests backlog"><h3 class="lm-kn-dayhead">Older overdue backlog (&gt;48h) <span class="mono">${staleQueue.length}</span></h3><div class="lmx-health-requests">${staleQueue.map(item => healthRequestRow(item, state.space))}</div></section>` : nothing}
            ${(d.data_errors || []).length ? html`<p class="muted" style="font-size:12px">${d.data_errors.length} data error(s) flagged: ${d.data_errors.slice(0, 3).map((e) => e.type).join(', ')}</p>` : nothing}
          ` : nothing}

          ${tab === 'audit' ? html`
            <section class="lm-plain-panel" style="display:flex;flex-wrap:wrap;gap:20px;align-items:center">
              <div style="flex:1 1 260px;display:flex;flex-direction:column;gap:6px">
                <span class="lm-eyebrow">7-day gate</span>
                <span style="font-size:20px;font-weight:600">${g.pass ? 'Pass' : `Not yet: ${g.days_passing || 0} of last 7 passing`}</span>
                <span style="font-size:13px" class="muted">Needs 7 consecutive passing days and the deliverable done.</span>
                ${earliest ? html`<span class="lmx-earliest" style="font-size:13px">${earliest.restart ? html`The run restarts ${earliest.restart}. ` : nothing}Earliest pass: <strong>${earliest.earliest}</strong>, if every day passes.</span>` : nothing}
              </div>
              <div style="flex:2 1 400px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">${strip}</div>
              <div style="flex:1 1 180px;display:flex;flex-direction:column;gap:6px">
                <span class="lm-eyebrow">Deliverable</span>
                ${stage((d.deliverable || {}).stage)}
                <span class="mono subtle" style="font-size:12px">job:${(d.deliverable || {}).job || ''}</span>
              </div>
            </section>
            <div class="lm-ftbar" id="health-history">
              <div class="lm-ftbar-pills" role="group" aria-label="Audit failure filters">
                ${[['all', 'All days'], ['mirror', 'Missing copies'], ['unanswered', 'Unanswered'], ['degraded', 'Degraded']].map(([value, label]) => html`<button type="button" class="lm-ftbar-pill" aria-pressed=${String((pf.auditFilter || 'all') === value)} @click=${() => selectAudit(value)}>${label} <span>${auditDays(d.days || [], value).length}</span></button>`)}
              </div>
              <span class="lmx-meta">${latestAudit ? `Latest audit: ${latestAudit.date} · opt-outs: ${num(latestAudit.mirror_opt_out)}` : 'No audit yet'}</span>
            </div>
            <div class="lmx-audit-history">${rows.length ? rows.map(day => auditBreakdownCard(day)) : emptyState((d.days || []).length ? 'No saved days match this filter.' : 'No checks yet.', (d.days || []).length ? 'Choose All days to inspect every returned audit.' : 'The first daily check writes its result here.')}</div>
          ` : nothing}

          ${tab === 'receipts' ? html`
            <p class="lmx-meta" style="margin:0">Saved coordination receipts only — this page has no live runner, scheduler, or provider billing feed.</p>
            ${d.source_status?.receipts === 'error' ? html`<p role="alert">Receipt storage could not be read. Retry this page.</p>` : runRows.length ? table(['Agent', 'Date', 'Morning', 'Midday', 'Closeout'], runRows) : emptyState('No coordination receipts saved for this date.', 'Agent execution and scheduling run in a separate runner.')}
            <div><a class="lm-btn lm-btn--secondary" style="text-decoration:none" href="#/slots">Open receipt calendar →</a></div>
          ` : nothing}
        </div>
      </section>
    `);
  };
  draw();
}
pages.audit = () => auditPage('audit');
pages.health = () => auditPage('health');
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
  let confirming = false;
  const bulk = () => (confirming ? inviteAllConfirm({ count: Math.min(pending.length, 200), onSend: (e) => invite(e, pending.slice(0, 200)), onCancel: () => { confirming = false; drawWaitlist(); } }) : btn(inviteAllLabel(pending.length), 'primary', () => { confirming = true; drawWaitlist(); }));
  const right = () => html`<span style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${canInvite && pending.length ? bulk() : nothing}<a class="lm-btn lm-btn--secondary" href="/api/waitlist?format=csv" download>Download CSV</a></span>`;
  const note = canInvite ? (inv.open ? ' Sign-up is open to everyone.' : ' Invite people into the managed beta.') : ' Invites need the customer Redis on this deploy.';
  const drawWaitlist = () => renderView('waitlist', ['Waitlist'], html`${head('Waitlist', `${num(d.total)} sign-ups. Each row keeps the first visit’s source.${note}`, right())}${canInvite ? riskNote(INVITE_RISK) : nothing}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">${counts('By source', d.by_source || [], 'source')}${counts('By plan', d.by_plan || [], 'plan')}${counts('By day', (d.by_day || []).slice(-14), 'day')}</div>
    ${rows.length ? table(['Email', 'Plan', 'Agents', 'Source', 'Referrer', 'First sign-up', 'Times', 'Beta'], rows) : emptyState('No sign-ups yet.', 'Sign-ups from /onboarding appear here.')}`);
  drawWaitlist();
};
pages.more = async () => {
  const d = await load('home'); if (!ok(d)) return; // sets the space, so the picker names it
  const link = (n) => html`<a class="lmx-card" style="text-decoration:none;color:inherit;flex-direction:row;align-items:center;gap:10px" href=${n[3] || '#/' + n[0]}>${icon(n[2])}<h3>${n[1]}</h3></a>`;
  const role = state.workspaces.find((w) => w.id === state.workspaceId)?.role;
  const g = moreGroups({ customer: Boolean(state.customer), role }, ADMIN);
  const group = (title, items) => (items.length ? html`<h2 class="lmx-colhead" style="margin-top:12px">${title}</h2>${items.map(link)}` : nothing);
  renderView('more', ['More'], html`<div class="lmx-stack">${g.workspace.map(link)}${group('You', g.you)}${group(state.customer ? 'Workspace admin' : 'Admin', g.admin)}<h2 class="lmx-colhead" style="margin-top:12px">Appearance</h2><div class="lmx-more-theme">${themePicker()}</div><button type="button" class="lm-btn lm-btn--secondary" style="margin-top:12px;min-height:44px" @click=${signOut}>Sign out</button></div>`);
};
export { jobLink, waitsTag, dueTag, state };
