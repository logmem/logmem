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
import { ADMIN } from './shell.js';
import { writerPage, playerPage } from './walk.js';

export const pages = {};
let okHook = () => true;
export function setOkHook(fn) { okHook = fn; }
const ok = (d) => okHook(d);
const col = (cls, title, n, body) => html`<section class=${cls}><h2 class="lmx-colhead">${title}${n != null ? html` <b>${n}</b>` : nothing}</h2><div class="lmx-stack">${body}</div></section>`;
const keyed = (list, key, tpl) => repeat(list, key, tpl);

// ─── Home: "Is the work moving?" ─────────────────────────────────────
pages.home = async () => {
  const d = await api('home');
  if (!ok(d)) return;
  live.needs = d.needs_count; live.home = d;
  const R = 'home';
  const plans = d.plans.length ? keyed(d.plans, (p) => p.id, (p) => planCard(p, R)) : emptyState('No plans yet.', 'Agents add jobs to plans with logmem_assign.');
  const blocked = d.blocked.length ? keyed(d.blocked, (b) => b.id, (b) => jobCard(b, { route: R })) : emptyState('Nothing is blocked.', 'A blocked job shows here with what it waits on and a button to fix it.');
  const agents = d.agents.length ? keyed(d.agents, (a) => a.id, (a) => agentChip(a, R)) : emptyState('No agents yet.', 'Connect one from Admin, Agent keys.');
  const liveN = d.agents.filter((a) => a.seen && a.seen.state === 'active').length;
  renderView(R, ['Home'], html`<div class="lmx-home">${col('lmx-c-plans', 'Plans', null, plans)}${col('lmx-c-blocked', 'Blocked', String(d.blocked.length), blocked)}${col('lmx-c-agents', 'Agents', `${liveN} live of ${d.agents.length}`, agents)}</div>`);
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
  const R = 'jobs';
  const all = (live.jobs || []).filter((j) => j.milestone !== true);
  const f = filt('jobs'), q = (f.q || '').toLowerCase(), week = Date.now() - 7 * 86400e3;
  const list = all.filter((j) => (!f.plan || j.plan === f.plan) && (!f.track || j.track === f.track) && (!f.owner || agentName(j.owner) === f.owner)
    && (!q || (j.title + ' ' + j.id + ' ' + (j.last ? j.last.summary : '')).toLowerCase().includes(q)) && !(j.stage === 'done' && j.stage_at && j.stage_at < week));
  const tracks = uniq(all.filter((j) => !f.plan || j.plan === f.plan).map((j) => j.track));
  const pick = f.stage || (list.some((j) => j.stage === 'blocked') ? 'blocked' : 'active');
  const setPick = (s) => () => { filt('jobs').stage = s; saveFilt(); drawJobs(); };
  renderView(R, ['Jobs'], html`
    <div class="lmx-filters">${selectBox('jobs', 'plan', 'Plan', uniq(all.map((j) => j.plan)), drawJobs)}${selectBox('jobs', 'track', 'Track', tracks, drawJobs)}${selectBox('jobs', 'owner', 'Owner', uniq(all.map((j) => agentName(j.owner))), drawJobs)}${searchBox('jobs', 'Title or last entry', drawJobs)}</div>
    <div class="lmx-stagechips lmx-phone-only" role="tablist">${BOARD.map((b) => html`<button type="button" role="tab" aria-selected=${pick === b[0]} @click=${setPick(b[0])}>${b[1].split(',')[0]} ${list.filter((j) => j.stage === b[0]).length}</button>`)}</div>
    <div class="lmx-board">${BOARD.map((b) => { const mine = list.filter((j) => j.stage === b[0]); return html`<section class="lmx-boardcol" data-stage=${b[0]} ?data-pick=${pick === b[0]}><h2 class="lmx-colhead">${b[1]} <b>${mine.length}</b></h2><div class="lmx-stack">${mine.length ? keyed(mine, (j) => j.id, (j) => boardCard(j, R)) : html`<p class="lmx-meta">None.</p>`}</div></section>`; })}</div>`);
}
pages.jobs = async () => { const d = await api('jobs'); if (!ok(d)) return false; live.jobs = d.jobs; drawJobs(); return true; };
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
  renderView('agents', ['Agents'], html`<div class="lmx-filters"><span class="lmx-meta">${liveN} of ${d.agents.length} wrote in the last 15 minutes.</span><span class="lm-spacer"></span><a href="/keys" class="lm-btn lm-btn--secondary" style="text-decoration:none">Agent keys</a></div>
    <div class="lmx-grid">${keyed(d.agents, (a) => a.id, agentCard)}</div>`);
};
pages.agent = async (id) => {
  const d = await api('agent', { id });
  if (!ok(d)) return;
  const r = d.recap, follows = Object.keys(d.follows || {});
  const recap = r ? html`<p style="margin:0 0 10px;font-size:15px">${r.summary}</p>${r.next && r.next.length ? html`<span class="lm-eyebrow">Next</span><ul style="margin:4px 0 10px;padding-left:18px">${r.next.map((n) => html`<li>${n}</li>`)}</ul>` : nothing}<div class="lm-prov"><span>${r.mode}${r.reason ? ' · ' + r.reason : ''}</span><span>shift ${r.shift}</span><span>${ago(r.ended_at)}</span></div>` : emptyState('No Recap yet.', 'This agent has not finished a shift.');
  const shifts = (d.shifts || []).map((s) => html`<tr><td class="mono" style="font-size:12px">${s.shift || ''}</td><td style="font-size:13px">${s.surface || ''}</td><td style="font-size:13px">${hhmm(s.ts)}</td><td style="font-size:13px">${s.auto ? 'auto' : 'manual'}</td></tr>`);
  renderView('agent', [html`<a href="#/agents">Agents</a>`, id], html`<div class="lm-row" style="gap:14px">${agent('agent:' + id)}${seenTag(d.seen)}</div>
    <p style="margin:0;font-size:13px" class="muted">This is what ${id} reads at the start of every shift (logmem_brief).</p>
    <div class="grid2">${panel('Last Recap', recap)}${panel('Now', kv(d.now))}${panel('Handoffs waiting for ' + id, d.handoffs.length ? entries(d.handoffs) : emptyState('Nothing waiting.', 'Handoffs show here until the agent accepts or declines them.'))}
      ${panel('Follows', follows.length ? follows.map((f) => html`<div class="lm-row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span class="mono" style="font-size:13px">${f}</span><span class="lm-badge">${(d.follows[f] || {}).role || ''}</span></div>`) : emptyState('Follows nothing.', 'Handoffs and logmem_follow add channels and jobs here.'))}</div>
    ${panel('Recent shifts', shifts.length ? table(['Shift', 'Host', 'Started', 'Start'], shifts) : emptyState('No shifts.', ''))}${panel('Log', entries(d.log))}`);
};

// ─── Log: "What exactly happened?" ──────────────────────────────────
function drawLog() {
  const all = live.log || [], f = filt('log'), q = (f.q || '').toLowerCase(), rc = live.recall;
  const list = all.filter((e) => (!f.where || String(e.where || '').indexOf(f.where + ':') === 0 || e.where === f.where) && (!f.agent || agentName(e.by) === f.agent) && (!f.kind || e.group === f.kind) && (!q || String(e.summary || '').toLowerCase().includes(q)));
  const places = ['job', 'channel', 'agent'].concat(uniq(all.map((e) => (/^channel:/.test(e.where || '') ? e.where : null))));
  let rq = rc ? rc.q : '';
  renderView('log', ['Log'], html`
    <form class="lmx-filters" role="search" @submit=${(e) => { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(e.target.q.value); }}>
      <label class="lmx-f lmx-f-q"><span>Recall</span><input class="lm-input" name="q" .value=${liveDir(rq)} placeholder="what did we decide about…"></label><button class="lm-btn lm-btn--primary" style="align-self:flex-end">Recall</button></form>
    <div class="lmx-filters">${selectBox('log', 'where', 'Where', places, drawLog)}${selectBox('log', 'agent', 'Who', uniq(all.map((e) => agentName(e.by))), drawLog)}${selectBox('log', 'kind', 'Kind', uniq(all.map((e) => e.group)), drawLog)}${searchBox('log', 'Words in the entry', drawLog)}</div>
    ${rc ? html`<section class="lmx-card"><h3>Recall: “${rc.q}”</h3>${rc.results.length ? rc.results.map((r) => html`<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="lm-kind">${r.kind}</span> ${r.summary}<div class="lmx-meta mono">${r.from} · trail ${r.trail || ''}</div></div><span class="lmx-meta">${ago(r.ts)}</span></div>`) : html`<p class="lmx-meta">No matches. Try fewer or different words.</p>`}</section>` : nothing}
    <section class="lm-panel" style="padding:8px 16px 16px">${list.length ? entries(list) : emptyState('Nothing matches.', 'Clear a filter to see more.')}<p class="lmx-meta">${list.length} of ${all.length} recent entries.</p></section>`);
}
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
  renderView('settings', ['Settings'], html`${head('Settings')}${panel('Space', kv({ space: d.space, keys: d.keys }))}
    ${panel('Storage', html`<div style="display:flex;flex-direction:column;gap:10px">${fresh('fresh', 'PING ' + d.ping_ms + ' ms')}<span style="font-size:13px" class="muted">Your Redis, over the deploy’s bridge connection.</span></div>`)}
    ${panel('ACMI compatibility', kv({ 'compatibility mode': d.compat ? 'on' : 'off', 'mirror to ACMI': d.mirror ? 'on for ' + d.mirror_spaces.join(', ') : 'off' }))}`);
};
pages.audit = async () => {
  const d = await api('audit');
  if (!ok(d)) return;
  const g = d.gate || {}, last7 = (d.days || []).slice(-7);
  const strip = Array.from({ length: 7 }, (_, i) => { const x = last7[i - (7 - last7.length)]; const st = !x ? 'background:var(--surface-sunken);color:var(--text-subtle)' : x.pass ? 'background:var(--success-subtle);color:var(--success)' : 'background:var(--danger-subtle);color:var(--danger)'; return html`<div style=${'display:flex;flex-direction:column;align-items:center;padding:10px 4px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;' + st}><span>${x ? x.date.slice(5) : '—'}</span><span>${x ? (x.pass ? 'PASS' : 'FAIL') : '—'}</span></div>`; });
  const rows = (d.days || []).slice().reverse().map((x) => html`<tr style="font-variant-numeric:tabular-nums"><td>${x.date}</td><td><span class=${'lm-badge lm-badge--' + (x.pass ? 'success' : 'danger')}>${x.pass ? 'Pass' : x.health_pass ? 'Low volume' : 'Fail'}</span></td><td>${num((x.agents || []).length)}</td><td>${num(x.entries)}</td><td>${num(x.accepted)} / ${num(x.handoffs)}</td><td>${x.mirror_checked ? num(x.mirror_mismatches) : 'n/a'}</td><td>${num(x.unanswered_24h)}</td><td>${num(x.degraded_sessions)}</td></tr>`);
  renderView('audit', ['Audit'], html`${head('Audit', 'The daily check that nothing was lost or left hanging. Each run writes a checkup entry to job:logmem-dogfood.')}
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
  renderView('more', ['More'], html`<div class="lmx-stack">${[['agents', 'Agents', 'agents'], ['log', 'Log', 'timeline'], ['recall', 'Recall', 'recall']].map(link)}<h2 class="lmx-colhead" style="margin-top:12px">Admin</h2>${ADMIN.map(link)}</div>`);
};
export { jobLink, waitsTag, dueTag, state };
