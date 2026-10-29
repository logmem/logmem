// views.js — every page. Each answers one question (live app spec, section 4) and is built from
// the shared parts in cards.js and ui.js. All markup is lit-html: nothing is concatenated as HTML.
import { html, nothing, svg } from '/vendor/lit-html-3.2.1/lit-html.js';
import { live as liveDir } from '/vendor/lit-html-3.2.1/directives/live.js';
import { repeat } from '/vendor/lit-html-3.2.1/directives/repeat.js';
import { api, getJSON, live, state, num, ago, hhmm, agentName, filt, saveFilt, uniq, isLate } from './core.js';
import { icon, agent, seenTag, fresh, stage, decision, entries, emptyState, panel, kv, table, head, btn, laneBadge, waitsTag, dueTag } from './ui.js';
import { jobCard, planCard, agentChip, boardCard, planRow, agentCard, laneCard, jobLink, askCard, copy } from './cards.js';
import { invite } from './actions.js';
import {launchpad} from './launchpad.js';
import {healthQueueItems,auditDays,overdueRequest,unindexedRequest} from './health-model.js';
import {healthRequestRow,auditBreakdownCard} from './health-components.js';
import {observeTelemetry} from './telemetry-state.js';
import {bentoTaskCard,planProgressTile,terminalActionBanner} from './today-components.js';
import {workspaceAssistant} from './shell.js';
import { renderView } from './shell.js';
import { openDrawer, drawerState } from './drawer.js';
import { ADMIN, signOut } from './shell.js';
import { briefFor, prioritizeWork, workFilterKey, groupUpdates, canAnswerDecision, splitHeadline, attentionKind, attentionCounts, filterAttention, splitPlans, PLAN_MODES, planMatch, planCounts, mergeTracks, dueState, WORK_MODES, workMatch, workCounts, trackKey, trackLabels, blockerNote, sharedBlockers, AGENT_MODES, agentMatch, agentCounts, groupDecisions, verdictLabel, agentColor, decisionGraph, splitDecisionRows, BOARD_FILTERS, boardMatch, boardCounts } from './dashboard-model.js';
import { writerPage, playerPage } from './walk.js';
import { handoffMap, timeScrubber, fleetPulse, blockerMap } from './flow-views.js';
import { agentProfile } from './profile-components.js';
import { blockerKind } from './flow-model.js';

import {agentDispatchButton,clusterBlockerGroup} from './dispatch-components.js';
import {blockerClusters} from './flow-model.js';
import {ticketPrompt} from './dispatch-model.js';
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
  observeTelemetry(state.space,{decisions:{value:Array.isArray(d.needs_items)?d.needs_items.filter(i=>i.type==='decision').length:null}});
  const b = briefFor(d), needs = d.needs_items || [];
  const waits = d.blocked.filter(j => !['task', 'decision'].includes(j.blocked_on?.type));
  const heading = b.decisions ? `${b.decisions === 1 ? 'One decision needs' : b.decisions + ' decisions need'} you.` : 'Your work,', sub = b.decisions ? 'Everything else is in view.' : 'in view.';
  if(state.customer&&b.total===0&&!d.agents.length)return renderView('home',['Today'],html`<h1>Your space is ready.</h1>${launchpad({data:d,space:state.space,refresh:()=>pages.home()})}`);
  const review = i => i.type==='task' ? openDrawer('needs','tasks') : i.job ? openDrawer('job',i.job) : openDrawer('needs','all');
  const attention = i => bentoTaskCard({item:i,space:state.space,review:()=>review(i)});
  const counts = attentionCounts(needs), pf = filt('home:'+state.space);
  const draw = () => {
  const shown = filterAttention(needs, pf.attn || 'all');
  const plans = splitPlans(d.plans || []);
  const setAttn = kind => () => { pf.attn = kind; saveFilt(); draw(); document.getElementById('today-board')?.scrollIntoView({ block: 'nearest' }); };
  const pills = [['all', 'All'], ['decision', 'Decisions'], ['task', 'Tasks'], ['review', 'Reviews']];
  renderView('home', ['Today'], html`
    <div class="lmx-today-heading lmx-hero"><div><span class="lm-eyebrow">Your workspace · ${state.customer?state.spaceRecords.find(s=>s.id===state.spaceId)?.name:state.space}</span><h1>${heading}<span>${sub}</span></h1><p>Decide what needs you. Keep the next step in view.</p>
      <div class="lmx-hero-note"><img src="/ds/logos/logmem-symbol.svg" alt="" width="34" height="24"><p>Counts describe the records loaded in this view. Open Inbox for unanswered coordination.</p></div></div>
      <a class="lm-btn lm-btn--secondary" href="#/queue">Open Inbox</a></div>
    ${launchpad({data:d,space:state.space,refresh:()=>pages.home()})}
    <div class="lmx-triage-strip" role="group" aria-label="Workspace status filters">${[['decision',b.decisions,'Decisions'],['task',b.tasks,'Tasks'],['waiting',b.blocked,'Waiting'],['done',b.done+' / '+b.total,'Done']].map(([kind,value,label])=>html`<button type="button" aria-pressed=${String(pf.attn===kind)} @click=${setAttn(pf.attn===kind?'all':kind)}><strong>${value??'Unknown'}</strong><span>${label}</span></button>`)}<span class="lmx-meta">Loaded workspace records · ${d.generated_at?ago(d.generated_at):'this read'}</span></div>
    ${terminalActionBanner({item:needs.find(i=>i.type==='decision'),space:state.space,review:()=>review(needs.find(i=>i.type==='decision'))})}
    <details class="lmx-coverage"><summary>What this view covers</summary><p>This summary reads a bounded set of records. Open Inbox for unanswered coordination and Health for receipt coverage. Counts describe this view only.</p>
      ${(d.coverage?.notes || []).map(n => html`<p>${n}</p>`)}${(d.coverage?.errors || []).map(e => html`<p role="alert">${e.source}: ${e.message}</p>`)}</details>
    <div class="lmx-today-grid"><div class="lmx-stack">
      <section id="today-board">${pf.attn==='waiting'?html`<h2 class="lmx-section-title">Waiting work <span>${d.blocked.length}</span></h2><div class="lmx-stack">${d.blocked.length?d.blocked.map(j=>jobCard(j,{route:'home'})):emptyState('No waiting work was returned.','This view covers loaded records only.')}</div>`:pf.attn==='done'?html`<h2 class="lmx-section-title">Completion by plan</h2><p class="lmx-meta">${b.done} of ${b.total} loaded work items are done. Open a plan for its completed work.</p><div class="lmx-stack">${(d.plans||[]).filter(p=>Number(p.done)>0).map(planProgressTile)}</div>`:html`<div class="lmx-board-head"><h2 class="lmx-section-title">Needs your attention <span>${needs.length}</span></h2><div class="lmx-filter" role="group" aria-label="Filter by type">${pills.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String((pf.attn || 'all') === k)} @click=${setAttn(k)}>${l} (${counts[k]})</button>`)}</div></div><div class="lmx-attention-grid">${shown.length ? keyed(shown, i => state.space + ':' + i.type + ':' + i.trail, attention) : needs.length ? emptyState('Nothing of this type.', 'Pick All to see every request.') : emptyState('No personal requests were returned.', 'The coordination backlog may contain other unanswered requests. See coverage above.') }</div>`}</section>
      ${!pf.attn||pf.attn==='all'?html`<section id="today-waiting"><h2 class="lmx-section-title">Waiting on your team <span>${waits.length}</span></h2><div class="lmx-stack">${waits.length ? keyed(waits, j => j.id, j => jobCard(j, {route:'home'})) : emptyState('No other blocked jobs were returned.', 'This is not a complete handoff backlog.')}</div></section>`:nothing}
      <section id="today-updates"><h2 class="lmx-section-title">Recent job updates</h2><div class="lmx-card lmx-update-list">${groupUpdates(d.recent || []).groups.slice(0,6).map(g => g.entries[0]).map(e => html`<div class="lmx-update"><div class="lmx-meta">${hhmm(e.ts)} · ${agentName(e.by)} · ${e.kind}</div><p>${e.summary}</p><a href=${'#/job/' + encodeURIComponent(e.where.replace(/^job:/,''))}>Open work →</a></div>`)}${!d.recent?.length ? html`<p class="lmx-meta">No recent job updates were returned. See coverage above.</p>` : nothing}</div><a href="#/activity" class="lmx-text-link">View Activity →</a></section>
    </div><details class="lmx-operations" ?open=${pf.operations!==false} @toggle=${e=>{pf.operations=e.currentTarget.open;saveFilt();}}><summary><strong>Operations</strong><span>Plans, team and workspace guidance</span></summary><div class="lmx-operations-body"><section><h2 class="lmx-section-title">Current priorities</h2><div class="lmx-stack">${keyed(plans.active, p => p.id, p => planProgressTile(p))}</div>${plans.empty.length ? html`<details class="lmx-parked-plans"><summary>Show ${plans.empty.length} parked ${plans.empty.length === 1 ? 'plan' : 'plans'}</summary><div class="lmx-stack">${keyed(plans.empty, p => p.id, p => planProgressTile(p))}</div></details>` : nothing}<a href="#/work" class="lmx-text-link">Open all work →</a></section>
      <p class="lmx-meta">${d.agents.length} agents have records. Reporting activity does not prove a running process. <a href="#/agents">Review team →</a></p><details class="lmx-operations-assistant"><summary>Workspace guidance</summary>${workspaceAssistant('home')}</details></div></details></div>`);
  };
  draw();
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
  const lateFn = (i) => isLate(i.due, i.stage);
  const done = items.filter((i) => i.stage === 'done').length;
  const late = items.filter(lateFn);
  const blocked = items.filter((i) => i.stage === 'blocked').length;
  const waiting = items.filter((i) => planMatch(i, 'waiting'));
  const toward = (m) => items.filter((i) => i.milestone && (i.milestone === m.id || String(m.title).indexOf(i.milestone + ':') === 0));
  const msName = (k) => { const m = d.milestones.find((x) => x.id === k); return m ? m.title + (m.date ? ' · ' + m.date : '') : k; };
  const tracks = mergeTracks(d.tracks), counts = planCounts(items, lateFn), pf = filt('plan:' + d.plan);
  const draw = () => {
    const mode = pf.mode || 'all', ms = d.milestones.find((m) => m.id === pf.ms);
    const inMs = ms ? new Set(toward(ms).map((i) => i.id)) : null;
    const plain = mode === 'all' && !inMs;
    const keep = (i) => planMatch(i, mode, lateFn) && (!inMs || inMs.has(i.id));
    const setMode = (k) => () => { pf.mode = k; saveFilt(); draw(); };
    const pickMs = (m) => () => { pf.ms = pf.ms === m.id ? '' : m.id; saveFilt(); draw(); };
    const slide = (dir) => () => { const el = document.getElementById('plan-ms-track'); if (el) el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.8), behavior: 'smooth' }); };
    const fade = (e) => { const el = e.currentTarget; el.parentElement.toggleAttribute('data-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 4); };
    const group = (list) => { const groups = {}; list.forEach((i) => { const k = i.milestone || 'No milestone'; (groups[k] = groups[k] || []).push(i); });
      const keys = Object.keys(groups).sort((a, b) => (a === 'No milestone') - (b === 'No milestone') || a.localeCompare(b));
      return keys.map((k) => html`<div class="lmx-pgroup"><div class="lmx-colhead" style="margin:10px 0 4px">${msName(k)}</div>${groups[k].map(planRow)}</div>`); };
    const trackCard = (t) => {
      const shown = t.items.filter(keep);
      if (!shown.length) return nothing;
      const doneRows = plain ? shown.filter((i) => i.stage === 'done') : [], liveRows = plain ? shown.filter((i) => i.stage !== 'done') : shown;
      const head = html`<h3>${t.title}</h3><span class="lmx-meta">${t.done}/${t.items.length} · ${num(t.percent)}%</span>`;
      if (plain && t.items.length && t.done === t.items.length) return html`<details class="lmx-card lmx-track lmx-track--done" data-key=${'track:' + t.title}><summary>${head}</summary>${group(doneRows)}</details>`;
      return html`<section class="lmx-card lmx-track" data-key=${'track:' + t.title}><div class="lmx-planhead">${head}</div><div class="lmx-bar"><i style=${`width:${num(t.percent)}%`}></i></div>
        ${group(liveRows)}${doneRows.length ? html`<details class="lmx-donejobs"><summary>+ ${doneRows.length} completed ${doneRows.length === 1 ? 'job' : 'jobs'} (Show ▾)</summary>${group(doneRows)}</details>` : nothing}</section>`;
    };
    renderView('plan', [html`<a href="#/lanes">Lanes</a>`, d.title || d.plan], html`
    <div class="lmx-stagechips">${d.plans.map((p) => html`<a href=${'#/plan/' + encodeURIComponent(p)} role="tab" aria-selected=${p === d.plan}>${p}</a>`)}</div>
    <section class="lmx-card"><div class="lmx-planhead"><h3 style="font-size:18px">${laneBadge(d.lane)}${d.title || d.plan}</h3><span class="lmx-planhead-r"><a class="lmx-chiplink" href=${'#/discussion/plan/' + encodeURIComponent(d.plan)}>Plan comments</a><span class="lmx-pct">${num(d.percent)}%</span></span></div>
      <div class="lmx-bar"><i style=${`width:${num(d.percent)}%`}></i></div>
      <div class="lmx-meta">${done} of ${items.length} done${blocked ? html` · <b style="color:var(--warning)">${blocked} blocked</b>` : nothing}${late.length ? html` · <b style="color:var(--danger)">${late.length} late</b>` : nothing}</div>
      <div class="lmx-filter" role="group" aria-label="Filter jobs">${PLAN_MODES.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String(mode === k)} @click=${setMode(k)}>${l} (${counts[k]})</button>`)}</div></section>
    ${d.milestones.length ? html`<section aria-label="Milestones"><div class="lmx-ms-head"><h2 class="lmx-section-title">Milestones <span>${d.milestones.length}</span></h2><div class="lmx-ms-nav"><button type="button" aria-label="Scroll milestones left" @click=${slide(-1)}>‹</button><button type="button" aria-label="Scroll milestones right" @click=${slide(1)}>›</button></div></div>
      <div class="lmx-ms-wrap" ?data-few=${d.milestones.length <= 4}><div class="lmx-rail-ms" id="plan-ms-track" @scroll=${fade}>${d.milestones.map((m) => { const mine = toward(m), md = mine.filter((i) => i.stage === 'done').length; return html`<button type="button" class="lmx-card lmx-ms" data-key=${'ms:' + m.id} ?data-done=${m.stage === 'done'} aria-pressed=${String(pf.ms === m.id)} title=${m.criteria || ''} @click=${pickMs(m)}><span class="lmx-ms-top"><span class="lmx-meta mono">${m.date || 'no date'}</span><strong class="lmx-ms-title">${m.title}</strong><span class="lmx-why lmx-ms-why">${m.criteria}</span></span><span class="lmx-meta">${stage(m.stage)}${mine.length ? ` · ${md}/${mine.length} jobs` : ''}</span></button>`; })}</div></div></section>` : nothing}
    ${ms ? html`<p class="lmx-meta">Showing jobs toward ${ms.title}. <button type="button" class="ob-linkbtn lmx-clearms" @click=${pickMs(ms)}>Clear milestone filter</button></p>` : nothing}
    ${plain && late.length ? html`<section class="lmx-card lmx-hot" data-tone="late"><h3>Late <span class="lmx-meta">${late.length}</span></h3>${late.map(planRow)}</section>` : nothing}
    ${plain && waiting.length ? html`<section class="lmx-card lmx-hot"><h3>Waiting on a person <span class="lmx-meta">${waiting.length}</span></h3>${waiting.map(planRow)}</section>` : nothing}
    <div class="lmx-stack">${tracks.map(trackCard)}</div>`);
  };
  draw();
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
const BOARD_MAIN = BOARD.slice(0, 3);
function drawJobs() {
  const R = workFilterKey(state.space);
  const all = prioritizeWork(live.jobs || []);
  const f = filt(R), q = (f.q || '').toLowerCase(), week = Date.now() - 7 * 86400e3;
  const lateFn = j => isLate(j.due, j.stage);
  const base = all.filter(j => (!f.plan || j.plan === f.plan) && (!f.track || trackKey(j.track) === trackKey(f.track)) && (!f.owner || agentName(j.owner) === f.owner)
    && (!q || (j.title + ' ' + j.id + ' ' + (j.last ? j.last.summary : '')).toLowerCase().includes(q)) && !(j.stage === 'done' && j.stage_at && j.stage_at < week));
  const layout = f.layout === 'board' ? 'board' : 'list';
  const mode = WORK_MODES.some(([k]) => k === f.status) ? f.status : 'live';
  const counts = workCounts(base, lateFn);
  const staleFn = j => (live.stale || []).includes(j.id);
  const bmode = BOARD_FILTERS.some(([k]) => k === f.bmode) ? f.bmode : 'all', bcounts = boardCounts(base, lateFn, staleFn);
  const kindOk = j => !f.bkind || (j.stage === 'blocked' && blockerKind(j) === f.bkind);
  const list = (layout === 'list' ? base.filter(j => workMatch(j, mode, lateFn)) : base.filter(j => boardMatch(j, bmode, lateFn, staleFn))).filter(kindOk);
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
    return html`<article class="lmx-work-row" data-key=${j.id}><div><h3><a href=${'#/job/' + encodeURIComponent(j.id)}>${j.title}</a></h3><div class="lmx-meta lmx-rowmeta"><span class="lmx-chip lmx-chip--lane">${j.plan || 'No plan'}</span>${j.track ? html`<span>${j.track}</span>` : nothing}<span class="lmx-chip">${j.owner ? agentName(j.owner) : 'Owner not assigned'}</span></div></div>
    <div>${stage(j.stage)}${j.blocked_on?.parked ? html`<span class="lm-badge">Parked</span>` : nothing}${note && shared.has(note) ? html` <span class="lmx-chip" title=${note}>Same blocker ×${shared.get(note)}</span>` : nothing}</div><div class="lmx-why lmx-why-clamp" title=${why}>${why}</div><div class="lmx-due" data-kind=${due.kind}>${due.kind === 'late' ? html`<span class="lmx-flag">${due.text}</span>` : html`<span class="lmx-meta">${due.text}</span>`}</div></article>`; };
  const grouped = () => { const groupedIds=new Set(clusters.flatMap(c=>c.jobs.map(j=>j.id)));
    return html`${clusters.map(c=>clusterBlockerGroup(c,state.space))}${list.filter(j=>!groupedIds.has(j.id)).map(row)}`;
  };
  const unknown = list.filter(j => !BOARD.some(b => b[0] === j.stage));
  const doneList = list.filter(j => j.stage === 'done');
  renderView('work', ['Work'], html`${head('Work', 'Priorities, owners, and the next step.')}<details class="lmx-queue-map"><summary>Show blocker map</summary>${blockerMap({ jobs: base, space: state.space, sel: f.blocker || '', kind: f.bkind || '', setKind: k => { f.bkind = k; saveFilt(); drawJobs(); }, pick: k => { f.blocker = k; saveFilt(); drawJobs(); }, copy })}</details><div class="lmx-work-toolbar"><div class="lmx-tabsbar" role="group" aria-label="Work layout"><button type="button" aria-pressed=${layout === 'list'} @click=${setLayout('list')}>List</button><button type="button" aria-pressed=${layout === 'board'} @click=${setLayout('board')}>Board</button></div><div class="lmx-work-links"><a href="#/lanes" class="lm-btn lm-btn--secondary">Plans and milestones</a><a href="#/queue" class="lm-btn lm-btn--secondary">Coordination queue</a></div></div>
    <div class="lmx-filters">${selectBox(R, 'plan', 'Plan', uniq(all.map(j=>j.plan)), drawJobs)}${selectBox(R, 'track', 'Track', tracks, drawJobs)}${selectBox(R, 'owner', 'Owner', uniq(all.map(j=>agentName(j.owner))), drawJobs)}${searchBox(R, 'Title or last entry', drawJobs)}</div>
    ${layout === 'board' ? html`<div class="lmx-filter" role="group" aria-label="Filter the board">${BOARD_FILTERS.map(([k, l]) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(bmode === k)} @click=${setBoardMode(k)}>${l} (${bcounts[k]})</button>`)}</div>` : nothing}
    ${layout === 'list' ? html`<div class="lmx-filter" role="group" aria-label="Filter by status">${WORK_MODES.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String(mode === k)} @click=${setMode(k)}>${l} (${counts[k]})</button>`)}${shared.size ? html`<button type="button" class="lmx-typepill lmx-typepill--toggle" aria-pressed=${String(f.group === 'blocker')} @click=${toggleGroup}>Group by blocker</button>` : nothing}</div>` : nothing}
    ${layout === 'list' ? html`<div class="lmx-work-list">${list.length ? (f.group === 'blocker' && shared.size ? grouped() : keyed(list, j=>j.id, row)) : emptyState('No work matches these filters.', 'Clear a filter or pick another status.')}</div>` : html`
      <div class="lmx-stagechips lmx-phone-only" role="tablist">${BOARD_MAIN.map(b=>html`<button type="button" role="tab" aria-selected=${pick === b[0]} @click=${setPick(b[0])}>${b[1].split(',')[0]} ${list.filter(j=>j.stage===b[0]).length}</button>`)}</div>
      <div class="lmx-board lmx-board--3">${BOARD_MAIN.map(b=>{ const mine=list.filter(j=>j.stage===b[0]); return html`<section class="lmx-boardcol" data-stage=${b[0]} ?data-pick=${pick===b[0]}><h2 class="lmx-colhead">${b[1]} <b>${mine.length}</b></h2><div class="lmx-stack">${keyed(mine,j=>j.id,j=>boardCard(j,'work',{space:state.space}))}${!mine.length ? html`<p class="lmx-meta">None.</p>` : nothing}</div></section>`; })}</div>
      <details class="lmx-donedrawer" ?open=${!!f.doneOpen} @toggle=${e=>{ if(e.target===e.currentTarget && f.doneOpen!==e.target.open){ f.doneOpen=e.target.open; saveFilt(); } }}><summary>Done, last 7 days <b>${doneList.length}</b></summary><div class="lmx-donegrid">${keyed(doneList,j=>j.id,j=>boardCard(j,'work',{space:state.space}))}${!doneList.length ? html`<p class="lmx-meta">None.</p>` : nothing}</div></details>
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
  const [d, lg] = await Promise.all([api('agents'), api('log').catch(() => null)]);
  if (!ok(d)) return;
  const pulseEntries = lg && Array.isArray(lg.entries) ? lg.entries : [];
  const liveN = d.agents.filter((a) => a.seen.state === 'active').length;
  const pf = filt('agents:' + state.space), counts = agentCounts(d.agents), open = (pf.open = pf.open || {});
  const draw = () => {
    const mode = AGENT_MODES.some(([k]) => k === pf.mode) ? pf.mode : 'fleet';
    const shown = d.agents.filter((a) => agentMatch(a, mode)), tucked = mode === 'fleet' ? d.agents.filter((a) => agentMatch(a, 'hidden')) : [];
    const setMode = (k) => () => { pf.mode = k; saveFilt(); draw(); };
    const card = (a) => agentCard(a, { open: !!open[a.id], space: state.space, toggle: () => { open[a.id] = !open[a.id]; saveFilt(); draw(); } });
    renderView('agents', ['Agents'], html`${head('Team', 'Who is doing what, and whether they report.')}<div class="lmx-filters"><span class="lmx-meta">${liveN} of ${d.agents.length} wrote in the last 15 minutes. This is reporting activity, not runtime presence.</span><span class="lm-spacer"></span><a href="#/slots" class="lm-btn lm-btn--secondary">Daily slots</a><a href="/keys" class="lm-btn lm-btn--secondary" style="text-decoration:none">Agent keys</a></div>
    ${fleetPulse({ entries: pulseEntries, agents: d.agents.map((a) => a.id), win: pf.win === 6 ? 6 : 24, sel: pf.lane || '', show: ['active', 'live', 'quiet', 'all'].includes(pf.show) ? pf.show : 'active', setShow: (k) => { pf.show = k; saveFilt(); draw(); }, setWin: (h) => { pf.win = h; saveFilt(); draw(); }, pick: (s) => { pf.lane = s; saveFilt(); draw(); } })}
    <div class="lmx-filter" role="group" aria-label="Filter the roster">${AGENT_MODES.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String(mode === k)} @click=${setMode(k)}>${l} (${counts[k]})</button>`)}</div>
    <section class="lmx-capability-note" role="note"><div class="lmx-capability-line"><span class="lm-badge lm-badge--info">Not connected</span><strong>Run and schedule receipts</strong></div><details><summary>What this means</summary><p>Request a run and Pause future runs remain unavailable until this space has a verified runner and enforceable limits. Copy prompt puts a ready prompt on your clipboard. It does not start anything.</p></details></section>
    <div class="lmx-agents-grid">${shown.length ? keyed(shown, (a) => a.id, card) : emptyState('No agents match.', 'Pick another filter.')}</div>
    ${tucked.length ? html`<details class="lmx-tucked"><summary>Show ${tucked.length} inactive or retired ${tucked.length === 1 ? 'slot' : 'slots'} ▾</summary><div class="lmx-agents-grid">${keyed(tucked, (a) => a.id, card)}</div></details>` : nothing}`);
  };
  draw();
};
pages.agent = async (id) => {
  const d = await api('agent', { id });
  if (!ok(d)) return;
  const pf = filt('agent:' + state.space + ':' + id);
  const draw = () => renderView('agent', [html`<a href="#/agents">Agents</a>`, id], agentProfile({ d, id, pf, space: state.space, redraw: () => { saveFilt(); draw(); } }));
  draw();
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
    ${timeScrubber({ entries: all, t: f.scrubT ?? null, scrub: (t) => { f.scrubT = t; drawLog(); } })}
    <section class="lm-panel" style="padding:8px 16px 16px">${f.allEvents ? entries(list) : html`${grouped.invalid.length ? html`<p role="alert">${grouped.invalid.length} updates have invalid or future timestamps. Inspect All events for their source records.</p>` : nothing}${grouped.groups.length ? grouped.groups.map(g=>html`<section class="lmx-activity-group"><h2 class="lmx-section-title">${g.where.startsWith('job:') ? html`<a href=${'#/job/'+encodeURIComponent(g.where.slice(4))}>${g.where}</a>` : g.where}</h2>${entries(g.entries)}</section>`) : emptyState('No work updates match.', 'Clear a filter or inspect All events. This is a bounded read window.')}` }<p class="lmx-meta">${list.length} of ${all.length} recent entries.</p></section>`);
}
pages.activity = () => pages.log();
pages.log = async () => { live.recall = null; const d = await api('log'); if (!ok(d)) return; live.log = d.entries; observeTelemetry(state.space,{activity:{value:Array.isArray(d.entries)?d.entries.length:null}}); drawLog(); };
pages.recall = async (q) => {
  const query = q || '';
  const [l, r] = await Promise.all([api('log'), query ? api('recall', { q: query }) : Promise.resolve({ results: [] })]);
  if (!ok(l)) return;
  live.log = l.entries; observeTelemetry(state.space,{activity:{value:Array.isArray(l.entries)?l.entries.length:null}}); live.recall = query ? { q: query, results: r.results || [] } : null; drawLog();
};
pages.channels = async (id) => { filt('log').where = id ? 'channel:' + id : 'channel'; saveFilt(); return pages.log(); };

// Knowledge keeps decisions and discussions attached to their existing sources.
pages.knowledge = async () => {
  const [d, c] = await Promise.all([api('decisions'), api('channels')]);
  if (!ok(d) || !ok(c)) return;
  const waiting = d.waiting || [], decided = d.decided || [];
  observeTelemetry(state.space,{decisions:{value:Array.isArray(d.waiting)?d.waiting.length:null}});
  // The card you picked glows and the rest dim for three seconds. Picking another card restarts the timer.
  const focusCard = (el) => { clearTimeout(focusCard.t); document.querySelectorAll('.lmx-focus').forEach((x) => x.classList.remove('lmx-focus')); el.classList.add('lmx-focus'); document.body.classList.add('lmx-focusing'); focusCard.t = setTimeout(() => { el.classList.remove('lmx-focus'); document.body.classList.remove('lmx-focusing'); }, 3000); };
  const jump = (trail) => { const el = document.querySelector('[data-key="decision:' + trail + '"]'); if (!el) return; const box = el.closest('details'); if (box) box.setAttribute('open', ''); el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); focusCard(el); };
  const { waiting: hot, clear } = splitDecisionRows(decisionGraph(waiting, decided)), W = 900, H = Math.max(60, hot.length * 34 + 24);
  const tip = (row, n) => `${agentName(row.agent)}: ${n.summary || 'Untitled decision'} · ${n.ts ? ago(n.ts) : 'time unavailable'}${n.state === 'pending' ? ' · waiting for you' : ' · settled'}`;
  const map = hot.length || clear.length ? html`<section class="lmx-neural" aria-label="Decision map"><h2 class="lmx-section-title">Decision map</h2><p class="lmx-meta">One row for each agent with something waiting. Glowing nodes wait on you. Hover a node to read it. Click a node to jump to its card. The cards below hold the same decisions.</p>
    ${hot.length ? html`<svg viewBox=${'0 0 ' + W + ' ' + H} role="presentation" aria-hidden="true">${hot.map((row, i) => { const y = 24 + i * 34, col = agentColor(row.agent), bx = 186 + row.nodes.length * 30 + 4; return svg`<g style=${'color:' + col}><text x="6" y=${y + 4} class="lmx-neural-label">${agentName(row.agent)}</text><line x1="170" y1=${y} x2=${170 + row.nodes.length * 30} y2=${y} class="lmx-neural-line"/>${row.nodes.map((n, j) => svg`<circle cx=${186 + j * 30} cy=${y} r="8" class=${'lmx-neural-node' + (n.state === 'pending' ? ' is-pending' : '')} @click=${() => jump(n.trail)}><title>${tip(row, n)}</title></circle>`)}<rect x=${bx} y=${y - 10} width="78" height="20" rx="10" class="lmx-neural-badgebg"/><text x=${bx + 39} y=${y + 4} class="lmx-neural-badge">${row.pending} pending</text></g>`; })}</svg>` : nothing}
    ${clear.length ? html`<p class="lmx-neural-clear"><b>All clear</b> ${clear.map((r) => html`<span class="lmx-neural-chip">${agentName(r.agent)}<i>${r.decided} settled</i></span>`)}</p>` : nothing}
    <ul class="lmx-flowkey"><li><i data-k="pend"></i>Waiting on you</li><li><i data-k="done"></i>Settled</li></ul></section>` : nothing;
  const histCard = ({ ask: a, answer }) => { const v = verdictLabel(answer?.payload?.verdict); return html`<article class="lmx-card" data-key=${'decision:' + a.trail}><div class="lmx-histhead"><h3>${a.summary}</h3>${v ? html`<span class="lmx-verdict" data-v=${answer.payload.verdict}>${v}</span>` : nothing}</div><div class="lmx-meta">${agentName(answer.by)} · ${answer.ts ? ago(answer.ts) : 'Timestamp unavailable'} <button type="button" class="lmx-idchip" title=${'Copy ' + a.trail} @click=${() => copy(a.trail)}>trail:…${String(a.trail).slice(-8)}</button></div>${entries([answer])}<a href=${'#/discussion/decision/'+encodeURIComponent(a.trail)}>Source comments</a></article>`; };
  renderView('knowledge', ['Knowledge'], html`${head('Knowledge', 'Find the reason behind the work. Decisions and discussions stay linked to their sources.')}
    <div class="lmx-cockpit-links"><a class="lm-btn lm-btn--secondary" href="#/activity">Browse Activity</a><a class="lm-btn lm-btn--secondary" href="#/lanes">Plans and milestones</a><a class="lm-btn lm-btn--secondary" href="#/recall">Search shared memory</a></div>
    <p class="lmx-meta">Decisions come from a bounded source window. An empty result does not prove there are no older decisions.</p>
    ${map}
    <section class="lmx-stack lmx-decisions" aria-label="Waiting decisions"><h2 class="lmx-section-title">Waiting decisions <span>${waiting.length}</span></h2>
      ${waiting.length ? keyed(waiting, a => a.trail, a => canAnswerDecision(a, {person:d.person,canApprove:!state.customer||Boolean(d.permissions?.approve)}) ? askCard(a) : html`<article class="lmx-card"><h3>${a.summary}</h3><p class="lmx-meta">${a.to ? 'Requested from '+agentName(a.to) : 'Approval permission required'}. This request is read-only here.</p><p>${a.payload?.action || 'Open the source for details.'}</p><a href=${'#/discussion/decision/'+encodeURIComponent(a.trail)}>Source comments</a></article>`) : emptyState('No waiting decisions were returned.', 'Open Inbox for other requests and coordination.')}</section>
    <section class="lmx-stack" aria-label="Decision history"><h2 class="lmx-section-title">Decision history <span>${decided.length}</span></h2>
      ${decided.length ? groupDecisions(decided).map((g) => html`<details class="lmx-bucket" ?open=${g.label === 'Today'}><summary>${g.label} <span>${g.items.length}</span></summary><div class="lmx-stack">${g.items.map(histCard)}</div></details>`) : emptyState('No settled decisions were returned.', 'Settled decisions appear when a verified answer matches the original request.')}</section>
    <section class="lmx-stack" aria-label="Shared discussions"><h2 class="lmx-section-title">Shared discussions</h2>
      ${(c.channels || []).length ? (c.channels || []).map(ch => html`<article class="lmx-card"><h3><a href=${'#/channels/'+encodeURIComponent(ch.id)}>${ch.id}</a></h3><p>${ch.last?.summary || 'No recent entry was returned.'}</p><div class="lmx-meta">${ch.last?.by ? agentName(ch.last.by) : 'Author unavailable'}${ch.last?.ts ? ' · '+ago(ch.last.ts) : ''}</div><a href=${'#/channels/'+encodeURIComponent(ch.id)}>Read source entries →</a></article>`) : emptyState('No discussion channels were returned.', 'Source discussions appear here when they exist in this space.')}</section>`);
};

// ─── Admin pages ─────────────────────────────────────────────────────
pages.settings = async () => {
  const d = await api('settings');
  if (!ok(d)) return;
  const pingOk = Number.isFinite(Number(d.ping_ms)), spaces = Array.isArray(d.mirror_spaces) ? d.mirror_spaces : [];
  const sw = (label, on, text) => html`<div class="lmx-control-row"><span>${label}</span><span class="lmx-switch" data-on=${String(on)} role="img" aria-label=${`${label}: ${text}`}><i aria-hidden="true"></i>${text}</span></div>`;
  const control = (title, status, body) => html`<section class="lmx-control"><header><h2>${title}</h2>${status || nothing}</header><div class="lmx-control-body">${body}</div></section>`;
  renderView('settings', ['Settings'], html`${head('Settings', 'Connections and administration for this space.')}
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
  const d = await api('slots', date ? { date } : {});
  if (!ok(d)) return;
  const rows = (d.agents || []).map((a) => html`<tr><td><a href=${'#/agent/' + encodeURIComponent(a.agent)}>${agentName(a.agent)}</a></td>${SLOT_ORDER.map((s) => slotCell(a.slots && a.slots[s]))}</tr>`);
  renderView('slots', ['Agents', 'Daily slots'], html`${head('Daily slots', 'Review coordination receipts by day. An empty slot past its window reads Missed.')}
    <div class="lmx-filters"><label>Run date <input type="date" class="lm-input" .value=${d.date || ''} @change=${(e) => { if (e.target.value && e.target.validity.valid) location.hash = '#/slots/' + encodeURIComponent(e.target.value); }}></label><span class="lmx-meta">${(d.agents || []).length} agents · America/New_York</span><span class="lm-spacer"></span><a href="#/audit" class="lm-btn lm-btn--secondary">Coordination audit</a><a href="#/agents" class="lm-btn lm-btn--secondary">Agents</a></div>
    <p class="muted">Receipts do not prove an active runner or a configured schedule.</p>
    ${rows.length ? table(['Agent', 'Morning', 'Midday', 'Closeout'], rows) : emptyState('No agents yet.', 'Slots appear once agents are in this space.')}`);
};
async function auditPage(route = 'audit') {
  const d = await api('audit');
  if (!ok(d)) return;
  const pf=filt('health:'+state.space);
  const observedAudit=d.days?.at(-1);
  observeTelemetry(state.space,{mirror:{value:d.source_status?.audit==='error'||observedAudit?.mirror_checked===false?null:typeof observedAudit?.mirror_mismatches==='number'?observedAudit.mirror_mismatches:null,label:d.source_status?.audit==='error'?'Unavailable':observedAudit?.mirror_checked===false?'Not enabled':'Unknown'}});
  const draw=()=>{
  const g = d.gate || {}, last7 = (d.days || []).slice(-7);
  const strip = Array.from({ length: 7 }, (_, i) => { const x = last7[i - (7 - last7.length)]; const st = !x ? 'background:var(--surface-sunken);color:var(--text-subtle)' : x.pass ? 'background:var(--success-subtle);color:var(--success)' : 'background:var(--danger-subtle);color:var(--danger)'; return html`<div style=${'display:flex;flex-direction:column;align-items:center;padding:10px 4px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;' + st}><span>${x ? x.date.slice(5) : '—'}</span><span>${x ? (x.paused ? 'PAUSED' : x.pass===true ? 'PASS' : x.pass===false ? 'FAIL' : 'UNKNOWN') : '—'}</span></div>`; });
  const rows = auditDays(d.days||[],pf.auditFilter||'all');
  // The coordination queue: open handoffs, seats and directed requests, sorted by how overdue they are.
  const q = d.pending || { items: [], total: 0, counts: {} };
  const c = q.counts || {};
  const queueItems=q.items||[],filtered=healthQueueItems(queueItems,pf.queueFilter||'all');
  const selectQueue=filter=>{pf.queueFilter=filter;saveFilt();draw();document.getElementById('health-queue')?.scrollIntoView({block:'nearest'});};
  const selectAudit=filter=>{pf.auditFilter=filter;saveFilt();draw();document.getElementById('health-history')?.scrollIntoView({block:'nearest'});};
  const queue = html`<section class="lmx-stack" id="health-queue">
    <h2 class="lmx-section-title">Open coordination queue <span>${num(q.total)}</span></h2>
    <p class="muted" style="font-size:13px">${num(c.handoffs)} handoffs · ${num(c.seats)} seats · ${num(c.directed)} directed · ${num(c.overdue)} overdue · coverage ${d.coverage || 'partial'}. Sorted by how overdue they are.</p>
    ${d.coverage !== 'full' ? html`<section class="lmx-coverage-note"><strong>Older handoffs still need indexing</strong><p>Saved requests remain in their source logs. This list combines indexed requests with recent source handoffs.</p><p>Run verified history indexing before treating this as the full backlog. Indexed requests support manager resolution in Inbox.</p></section>` : nothing}
    <div class="lmx-health-filters" role="group" aria-label="Coordination queue filters">${[['all','All',queueItems.length],['overdue','Overdue',queueItems.filter(i=>overdueRequest(i)).length],['unindexed','Not indexed',queueItems.filter(unindexedRequest).length]].map(([value,label,count])=>html`<button type="button" class="lmx-typepill" aria-pressed=${String((pf.queueFilter||'all')===value)} @click=${()=>selectQueue(value)}>${label} (${count})</button>`)}<span class="lmx-meta">Filters cover loaded records.</span></div>
    <p class="lmx-meta">${!pf.queueFilter||pf.queueFilter==='all'?'Showing '+queueItems.length+' of '+num(q.total)+' returned records.':'Showing '+filtered.length+' matching records from '+queueItems.length+' loaded. '+num(q.total)+' reported in total.'}</p>
    ${filtered.length?html`<div class="lmx-health-requests">${filtered.map(item=>healthRequestRow(item,state.space))}</div>`:emptyState(queueItems.length?'No loaded records match this filter.':'No open records were returned.',queueItems.length?'Choose another filter.':d.coverage==='full'?'No unanswered handoffs, seats or directed requests were found.':'Check coverage before treating this as an empty backlog.')}
    <a class="lm-btn lm-btn--secondary" href="#/queue">Review requests in Inbox</a>
    ${(d.data_errors || []).length ? html`<p class="muted" style="font-size:12px">${d.data_errors.length} data error(s) flagged: ${d.data_errors.slice(0, 3).map((e) => e.type).join(', ')}</p>` : nothing}</section>`;
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
  const dailyRuns = html`<details class="lmx-coverage" aria-label="Saved coordination checks"><summary>Saved coordination checks (${recordedRuns.length} agents)</summary>
    <p>These are saved receipts. This page has no scheduler connection and does not start agent runs.</p>
    ${d.source_status?.receipts === 'error' ? html`<p role="alert">Receipt storage could not be read. Retry this page.</p>` : runRows.length ? table(['Agent', 'Date', 'Morning', 'Midday', 'Closeout'], runRows) : html`<p>No coordination receipts were saved for this date. Agent execution and scheduling need a separate runner.</p>`}
    <a href="#/slots">Open receipt calendar</a></details>`;
  renderView(route, [route === 'health' ? 'Health' : 'Audit'], html`${route === 'health' ? html`${head('Health', 'See missing receipts and unresolved coordination before work falls through.')}<div class="lmx-cockpit-links"><a class="lm-btn lm-btn--secondary" href="#/slots">Daily receipt calendar</a><a class="lm-btn lm-btn--secondary" href="#/activity">Source Activity</a><a class="lm-btn lm-btn--secondary" href="#/agents">Team records</a></div><section class="lmx-health-metrics" aria-label="Coordination health summary">${[['Open coordination',q.total,'all'],['Overdue responses',c.overdue,'overdue'],['Agents with saved checks',d.source_status?.receipts==='error'?'Unavailable':recordedRuns.length,'receipts'],['Missing compatibility copies',mirrorValue,'mirror']].map(([label,value,filter])=>html`<button type="button" data-tone=${filter} @click=${()=>{if(filter==='receipts'){const el=document.querySelector('[aria-label="Saved coordination checks"]');if(el){el.open=true;el.scrollIntoView({block:'nearest'});}}else if(filter==='mirror')selectAudit('mirror');else selectQueue(filter);}}><strong>${value??'Unknown'}</strong><span>${label}</span></button>`)}</section><p class="lmx-meta">Updated ${d.generated_at ? hhmm(d.generated_at) : 'with this request'} · ${d.coverage || 'partial'} index coverage. Mirror counts describe the latest audit window.</p><details class="lmx-coverage"><summary>About missing compatibility copies</summary>${d.source_status?.audit === 'error' ? html`<p role="alert">Audit history could not be read. Retry this page.</p>` : latestAudit ? html`<p>Audit date: ${latestAudit.date}. ${latestAudit.window ? 'Window: '+new Date(latestAudit.window[0]).toLocaleString()+' to '+new Date(latestAudit.window[1]).toLocaleString()+'.' : 'The saved audit has no exact window metadata.'}</p><p>This counts log rows without an ACMI copy in that window. It does not measure a cumulative backlog or prove the original LogMem entry was lost.</p><p>Intentional mirror opt-outs: ${num(latestAudit.mirror_opt_out)}. Diagnose the writer policy and retry queue before replaying records.</p>` : html`<p>No audit result is available.</p>`}</details><details class="lmx-coverage"><summary>Runtime, billing and usage coverage</summary><p>This page has no live provider usage, billing, runner or schedule feed. Receipt records show saved checks only.</p></details>` : nothing}${queue}${dailyRuns}${head('Audit', 'The daily check that nothing was lost or left hanging. Each run writes a checkup entry to job:logmem-dogfood.')}
    <section class="lm-panel" style="padding:20px;display:flex;flex-wrap:wrap;gap:24px;align-items:center"><div style="flex:1 1 280px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">7-day gate</span><span style="font-size:22px;font-weight:600">${g.pass ? 'Pass' : `Not yet: ${g.days_passing || 0} of last 7 passing`}</span><span style="font-size:13px" class="muted">Needs 7 consecutive passing days and the deliverable done.</span></div>
      <div style="flex:2 1 420px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">${strip}</div><div style="flex:1 1 200px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">Deliverable</span>${stage((d.deliverable || {}).stage)}<span class="mono subtle" style="font-size:12px">job:${(d.deliverable || {}).job || ''}</span></div></section>
    <section id="health-history"><h2 class="lmx-section-title">Audit history</h2><div class="lmx-filter" role="group" aria-label="Audit failure filters">${[['all','All days'],['mirror','Missing copies'],['unanswered','Unanswered'],['degraded','Degraded']].map(([value,label])=>html`<button type="button" class="lmx-typepill" aria-pressed=${String((pf.auditFilter||'all')===value)} @click=${()=>selectAudit(value)}>${label} (${auditDays(d.days||[],value).length})</button>`)}</div><div class="lmx-audit-history">${rows.length?rows.map(auditBreakdownCard):emptyState((d.days||[]).length?'No saved days match this filter.':'No checks yet.',(d.days||[]).length?'Choose All days to inspect every returned audit.':'The first daily check writes its result here.')}</div></section>`);
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
