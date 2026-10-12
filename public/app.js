// app.js — the LogMem web app. Hash routes, live data from /api/view (read-only).
// The one write: Approve / Reject / Defer on an ask, POSTed to /api/decide.
// Every value from the server is escaped before it reaches the page.
(function () {
  'use strict';
  var root = document.getElementById('root');
  var esc = function (s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  // Numbers from the server are coerced, never trusted as markup.
  var num = function (v) { var n = Number(v); return Number.isFinite(n) ? String(n) : '0'; };
  var icon = function (n) { return '<i class="lm-i" data-i="' + n + '" aria-hidden="true"></i>'; };
  var state = { space: null, spaces: [] };
  try { state.space = localStorage.getItem('lm-space'); } catch (e) {}

  // ─── time ─────────────────────────────────────────────────────────
  function hhmm(ts) { var d = new Date(ts); var today = new Date().toDateString() === d.toDateString(); return (today ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ') + d.toISOString().slice(11, 16); }
  function ago(ts) { if (!ts) return 'never'; var m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; }

  // ─── components (markup matches the LogMem design system bundle) ─
  var HUES = ['viz-1', 'viz-2', 'viz-3', 'viz-5', 'viz-4', 'viz-6'];
  function hue(name) { var h = 0; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return HUES[h % HUES.length]; }
  function agentName(by) { return String(by || '').replace(/^agent:/, '').replace(/^human:/, ''); }
  function agent(by) {
    var n = agentName(by) || '?'; var human = /^human:/.test(by || '');
    var ini = n.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
    return '<span class="lm-agent"><span class="lm-avatar"' + (human ? ' data-human' : ' style="background:var(--' + hue(n) + ')"') + ' aria-hidden="true">' + esc(ini) + '</span><span class="lm-agent-name">' + esc(n) + '</span></span>';
  }
  function seenTag(s) { var label = { active: 'Wrote in the last 15 min', idle: 'Quiet', offline: 'No recent entries', unknown: 'Never wrote' }[s.state]; return '<span class="lm-presence" data-p="' + esc(s.state) + '">' + esc(label) + (s.since && s.state !== 'unknown' ? ' · ' + esc(s.since) : '') + '</span>'; }
  function fresh(st, age) { var f = { fresh: ['check', 'Fresh'], stale: ['clock', 'Stale'], unavailable: ['alert', 'Unavailable'], disconnected: ['unplug', 'Disconnected'] }[st]; return '<span class="lm-fresh" data-s="' + st + '">' + icon(f[0]) + f[1] + (age ? ' · ' + esc(age) : '') + '</span>'; }
  function decision(st, label) { var d = { pending: ['hourglass', 'Pending decision'], approved: ['check', 'Approved'], rejected: ['x', 'Rejected'], deferred: ['defer', 'Deferred'], failed: ['alert', 'Failed'], completed: ['check', 'Completed'], 'in-progress': ['refresh', 'In progress'], blocked: ['pause', 'Blocked'] }[st] || ['unknown', st]; return '<span class="lm-decision" data-d="' + esc(st) + '">' + icon(d[0]) + esc(label || d[1]) + '</span>'; }
  var STAGE = { open: ['deferred', 'Open'], active: ['in-progress', 'Active'], blocked: ['blocked', 'Blocked'], done: ['completed', 'Done'] };
  function stage(s) { var x = STAGE[s] || ['deferred', s || 'Open']; return decision(x[0], x[1]); }
  function entry(e, sel) {
    return '<div class="lm-event" data-k="' + esc(e.group) + '"' + (sel ? ' aria-selected="true"' : '') + '>' +
      '<time class="lm-event-time time" datetime="' + new Date(e.ts).toISOString() + '">' + hhmm(e.ts) + '</time><span class="lm-event-rule" aria-hidden="true"></span>' +
      '<div class="lm-event-main"><div class="lm-event-line"><span class="lm-kind">' + esc(e.kind) + '</span><strong style="font-size:14px">' + esc(agentName(e.by)) + '</strong><span class="lm-event-summary">' + esc(e.summary) + '</span></div>' +
      '<div class="lm-prov"><span>' + esc(e.where) + '</span>' + (e.trail ? '<span>trail ' + esc(e.trail) + '</span>' : '') + (e.origin ? '<span>↳ origin ' + esc(e.origin) + '</span>' : '') + (e.via ? '<span>via ' + esc(e.via) + '</span>' : '') + (e.unverified ? '<span>unverified</span>' : '') + '</div></div></div>';
  }
  function entries(list, empty) { return list && list.length ? '<div class="lm-events">' + list.map(function (e) { return entry(e); }).join('') + '</div>' : emptyState(empty || 'No entries yet.', 'Connect an agent and its entries will appear here in order. Nothing is invented while you wait.'); }
  function emptyState(title, body) { return '<div class="lm-empty" style="max-width:none"><span class="lm-title-3" style="font-size:14px;font-weight:600">' + esc(title) + '</span><span style="font-size:13px">' + esc(body) + '</span></div>'; }
  function panel(title, body, extra) { return '<section class="lm-panel"><div class="lm-panel-head"><h2 class="lm-title-2" style="margin:0;font-size:17px">' + esc(title) + '</h2><span class="lm-spacer"></span>' + (extra || '') + '</div><div style="padding:12px 20px 16px">' + body + '</div></section>'; }
  function kv(obj) { var keys = Object.keys(obj || {}); return keys.length ? '<dl class="lm-kv">' + keys.map(function (k) { var v = obj[k]; return '<dt>' + esc(k) + '</dt><dd>' + esc(typeof v === 'object' ? JSON.stringify(v) : v) + '</dd>'; }).join('') + '</dl>' : '<span class="subtle" style="font-size:13px">Nothing set.</span>'; }
  function table(head, rows) { return '<div class="lm-table-wrap"><table class="lm-table"><thead><tr>' + head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'; }

  // ─── shell ────────────────────────────────────────────────────────
  var NAV = [['overview', 'Overview', 'overview'], ['log', 'Log', 'timeline'], ['agents', 'Agents', 'agents'], ['jobs', 'Jobs', 'work'], ['channels', 'Channels', 'link'], ['decisions', 'Decisions', 'decisions'], ['recall', 'Recall', 'recall'], ['settings', 'Settings', 'settings'], ['audit', 'Audit', 'eye']];
  function shell(route, crumbs, body, waitingCount) {
    var demo = state.space === 'fieldnotes';
    return '<div class="shell"><nav class="lm-rail" aria-label="LogMem">' +
      '<div class="lm-rail-brand"><a href="/" style="display:flex"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:26px;width:auto"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:26px;width:auto"></a></div>' +
      '<label class="lm-field" style="margin:0 4px 12px"><span class="lm-label">Space</span><select class="lm-select" id="space">' + state.spaces.map(function (s) { return '<option' + (s === state.space ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
      NAV.map(function (n) { var cur = n[0] === route; return '<a href="#/' + n[0] + '" class="lm-nav-item"' + (cur ? ' aria-current="page" style="background:var(--brand-subtle);color:var(--brand)"' : '') + '>' + icon(n[2]) + '<span>' + n[1] + '</span>' + (n[0] === 'decisions' && waitingCount ? '<span class="lm-count">' + waitingCount + '</span>' : '') + '</a>'; }).join('') +
      '<div class="lm-rail-foot">' + (demo ? '<span class="lm-badge lm-badge--warning">Sandbox space</span><span style="font-size:12px" class="subtle">fieldnotes holds a scripted test team.</span>' : '<span style="font-size:12px" class="subtle">Live space</span>') + '<button type="button" class="lm-btn lm-btn--ghost" id="signout" style="justify-content:flex-start">Sign out</button></div></nav>' +
      '<div class="col"><header class="lm-header"><ol class="lm-crumbs">' + crumbs.map(function (c, i) { return (i ? '<li aria-hidden="true">/</li>' : '') + '<li' + (i === crumbs.length - 1 ? ' aria-current="page" style="color:var(--text)"' : '') + '>' + c + '</li>'; }).join('') + '</ol>' +
      '<form class="lm-search" id="jump" role="search"><i class="lm-i" data-i="search" aria-hidden="true"></i><input class="lm-input" name="q" placeholder="Recall: search the log" aria-label="Search the log" style="padding-left:32px"></form></header>' +
      '<main class="lm-main" style="max-width:1280px">' + body + '</main></div></div>';
  }
  function head(title, sub, right) { return '<div class="lm-row" style="justify-content:space-between"><div style="display:flex;flex-direction:column;gap:4px"><h1 class="lm-title-1" style="margin:0;font-size:22px">' + esc(title) + '</h1>' + (sub ? '<span style="font-size:13px" class="muted">' + sub + '</span>' : '') + '</div>' + (right || '') + '</div>'; }

  // ─── data ─────────────────────────────────────────────────────────
  function api(what, extra) {
    var q = new URLSearchParams(Object.assign({ what: what }, state.space ? { space: state.space } : {}, extra || {}));
    return fetch('/api/view?' + q, { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); });
  }

  // ─── pages ────────────────────────────────────────────────────────
  var pages = {
    overview: function () {
      return api('overview').then(function (d) {
        if (!ok(d)) return;
        var s = d.stats;
        var stats = [['Active', s.active, 'of ' + s.agents + ' agents'], ['Open jobs', s.open, ''], ['Stuck', s.stuck, ''], ['Waiting on you', s.waiting, '']].map(function (x, i) {
          return '<div class="lm-stat"><span class="lm-eyebrow">' + x[0] + '</span><span class="big"' + (i === 2 && x[1] ? ' style="color:var(--warning)"' : i === 3 && x[1] ? ' style="color:var(--decision)"' : '') + '>' + x[1] + '</span><span style="font-size:12px" class="subtle">' + esc(x[2]) + '</span></div>';
        }).join('');
        var waiting = d.waiting.length ? d.waiting.map(askCard).join('') : emptyState('Nothing waiting on you.', 'When an agent calls logmem_ask, it stops and waits here.');
        var stuck = d.jobs.filter(function (j) { return j.stage === 'blocked'; });
        var ag = d.agents.length ? table(['Agent', 'Now', 'Last entry'], d.agents.map(function (a) { return '<tr><td><a href="#/agent/' + encodeURIComponent(a.id) + '" style="text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:4px">' + agent('agent:' + a.id) + seenTag(a.seen) + '</a></td><td style="font-size:13px">' + esc((a.now && (a.now.doing || (a.now.waiting_on && 'Waiting on you'))) || '—') + '</td><td style="font-size:13px" class="muted">' + esc(a.last ? a.last.summary : '—') + '</td></tr>'; })) : emptyState('No agents yet.', 'Connect one from Settings.');
        render('overview', ['Overview'], head('Overview', 'Live from space ' + esc(state.space) + ' · ' + new Date(d.generated_at).toUTCString().slice(17, 22) + ' UTC') +
          '<div class="lm-stats">' + stats + '</div>' +
          '<div class="grid2">' + panel('Waiting on you', waiting, '<a href="#/decisions" style="font-size:13px">All decisions</a>') + panel('Stuck', stuck.length ? stuck.map(function (j) { return '<div class="lm-blocker">' + icon('pause') + '<div><strong>' + esc(j.title) + '</strong> · ' + esc(j.last ? j.last.summary : '') + '</div></div>'; }).join('') : emptyState('Nothing is stuck.', 'Jobs set to blocked show here with what broke.')) + '</div>' +
          '<div class="grid2">' + panel('Agents', ag, '<a href="#/agents" style="font-size:13px">All agents</a>') + panel('Recent log', entries(d.recent), '<a href="#/log" style="font-size:13px">Open the Log</a>') + '</div>', s.waiting);
      });
    },
    log: function () {
      return api('log').then(function (d) {
        if (!ok(d)) return;
        render('log', ['Log'], head('Log', 'Every entry in ' + esc(state.space) + ', newest first. LogMem never rewrites what an agent wrote.', fresh('fresh', 'loaded ' + ago(d.generated_at))) + '<section class="lm-panel" style="padding:8px 20px 16px">' + entries(d.entries) + '</section>');
      });
    },
    agents: function () {
      return api('agents').then(function (d) {
        if (!ok(d)) return;
        var rows = d.agents.map(function (a) {
          return '<tr><td><a href="#/agent/' + encodeURIComponent(a.id) + '" style="text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:6px">' + agent('agent:' + a.id) + seenTag(a.seen) + '</a></td><td style="font-size:13px;max-width:280px">' + esc((a.now && a.now.doing) || '—') + '</td><td class="mono" style="font-size:12px">' + esc(a.shift ? a.shift.shift || '' : '—') + '<br><span class="subtle" style="font-size:11px">' + esc(a.shift ? (a.shift.surface || '') : '') + '</span></td><td>' + (a.recap ? fresh('fresh', a.recap.mode + (a.recap.reason ? ', ' + a.recap.reason : '')) : fresh('unavailable', 'no Recap yet')) + '</td></tr>';
        });
        render('agents', ['Agents'], head('Agents', d.agents.length + ' agents in ' + esc(state.space) + '. “Last entry” is how recently an agent wrote; it says nothing about whether the work is going well.', '<a href="/onboarding" class="lm-btn lm-btn--primary" style="text-decoration:none">' + icon('plus') + 'Connect an agent</a>') + (rows.length ? table(['Agent', 'Now', 'Shift', 'Last Recap'], rows) : emptyState('No agents yet.', 'Connect an agent and it appears here after its first call.')));
      });
    },
    agent: function (id) {
      return api('agent', { id: id }).then(function (d) {
        if (!ok(d)) return;
        var r = d.recap;
        var recap = r ? '<p style="margin:0 0 10px;font-size:15px">' + esc(r.summary) + '</p>' + (r.next && r.next.length ? '<span class="lm-eyebrow">Next</span><ul style="margin:4px 0 10px;padding-left:18px">' + r.next.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + '<div class="lm-prov"><span>' + esc(r.mode) + (r.reason ? ' · ' + esc(r.reason) : '') + '</span><span>shift ' + esc(r.shift) + '</span><span>' + ago(r.ended_at) + '</span></div>' : emptyState('No Recap yet.', 'This agent has not finished a shift.');
        var follows = Object.keys(d.follows || {});
        var shifts = (d.shifts || []).map(function (s) { return '<tr><td class="mono" style="font-size:12px">' + esc(s.shift || '') + '</td><td style="font-size:13px">' + esc(s.surface || '') + '</td><td style="font-size:13px">' + hhmm(s.ts) + '</td><td style="font-size:13px">' + (s.auto ? 'auto' : 'manual') + '</td></tr>'; });
        render('agents', ['<a href="#/agents">Agents</a>', esc(id)], '<div class="lm-row" style="gap:14px">' + agent('agent:' + id) + seenTag(d.seen) + '</div>' +
          '<p style="margin:0;font-size:13px" class="muted">This is what ' + esc(id) + ' reads at the start of every shift (logmem_brief).</p>' +
          '<div class="grid2">' + panel('Last Recap', recap) + panel('Now', kv(d.now)) + panel('Handoffs waiting for ' + id, d.handoffs.length ? entries(d.handoffs) : emptyState('Nothing waiting.', 'Handoffs show here until the agent accepts or declines them.')) + panel('Follows', follows.length ? follows.map(function (f) { return '<div class="lm-row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span class="mono" style="font-size:13px">' + esc(f) + '</span><span class="lm-badge">' + esc((d.follows[f] || {}).role || '') + '</span></div>'; }).join('') : emptyState('Follows nothing.', 'Handoffs and logmem_follow add channels and jobs here.')) + '</div>' +
          panel('Recent shifts', shifts.length ? table(['Shift', 'Host', 'Started', 'Start'], shifts) : emptyState('No shifts.', '')) + panel('Log', entries(d.log)));
      });
    },
    jobs: function () {
      return api('jobs').then(function (d) {
        if (!ok(d)) return;
        var rows = d.jobs.map(function (j) { return '<tr><td><a href="#/job/' + encodeURIComponent(j.id) + '" style="font-weight:600;text-decoration:none;color:var(--text)">' + esc(j.title) + '</a><br><span class="mono subtle" style="font-size:11px">job:' + esc(j.id) + (j.due ? ' · due ' + esc(j.due) : '') + '</span></td><td>' + (j.owner ? agent(j.owner) : '—') + '</td><td>' + stage(j.stage) + '</td><td style="font-size:13px">' + (j.last ? '<span class="lm-kind">' + esc(j.last.kind) + '</span> ' + esc(j.last.summary) + ' <span class="subtle">' + ago(j.last.ts) + '</span>' : '—') + '</td></tr>'; });
        render('jobs', ['Jobs'], head('Jobs', 'A job has one owner, a stage and its own log. Agents open them with logmem_assign.') + (rows.length ? table(['Job', 'Owner', 'Stage', 'Last entry'], rows) : emptyState('No jobs yet.', 'Jobs appear when an agent calls logmem_assign.')));
      });
    },
    job: function (id) {
      return api('job', { id: id }).then(function (d) {
        if (!ok(d)) return;
        var who = d.who || {};
        // Open asks are computed on the server (signed approve/reject only; defer stays open).
        var open = d.open_asks || [];
        render('jobs', ['<a href="#/jobs">Jobs</a>', esc(id)], '<div style="display:flex;flex-direction:column;gap:10px"><h1 class="lm-title-1" style="margin:0;font-size:22px">' + esc(who.title || id) + '</h1><div class="lm-row" style="gap:14px">' + stage(d.now.stage) + (d.now.owner ? '<span class="muted" style="font-size:13px">Owner</span>' + agent(d.now.owner) : '') + '<span class="mono subtle" style="font-size:12px">job:' + esc(id) + '</span></div></div>' +
          '<div class="split"><div class="main">' + panel('Job log', entries(d.log), '<span class="subtle" style="font-size:13px">' + d.log.length + ' entries · ' + (d.shifts || []).length + ' shifts</span>') + '</div><div class="side" style="display:flex;flex-direction:column;gap:24px">' + open.map(askCard).join('') + panel('Who', kv(who)) + panel('Now', kv(d.now)) + '</div></div>');
      });
    },
    channels: function (id) {
      return api('channels', id ? { id: id } : {}).then(function (d) {
        if (!ok(d)) return;
        var list = d.channels.map(function (c) { var cur = c.id === d.selected; return '<li><a href="#/channels/' + encodeURIComponent(c.id) + '" style="display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:var(--radius-md);text-decoration:none;color:var(--text)' + (cur ? ';background:var(--brand-subtle)' : '') + '"' + (cur ? ' aria-current="page"' : '') + '><span class="mono" style="font-size:13px;font-weight:500">' + esc(c.id) + '</span><span class="subtle" style="font-size:12px">' + (c.last ? esc(agentName(c.last.by)) + ' · ' + ago(c.last.ts) : 'empty') + '</span></a></li>'; }).join('');
        render('channels', ['Channels'].concat(d.selected ? [esc(d.selected)] : []), head('Channels', 'Shared logs several agents write to.') + (d.channels.length ? '<div class="split"><nav class="lm-panel side" style="max-width:320px" aria-label="Channels"><ul style="list-style:none;margin:0;padding:6px">' + list + '</ul></nav><div class="main">' + panel('channel:' + d.selected, entries(d.log)) + '</div></div>' : emptyState('No channels yet.', 'Channels appear when an agent writes a note to one.')));
      });
    },
    decisions: function () {
      return api('decisions').then(function (d) {
        if (!ok(d)) return;
        var hist = d.decided.map(function (x) { var v = (x.answer.payload || {}).verdict; return '<tr><td style="font-size:14px">' + esc(x.ask.summary) + '</td><td style="font-size:13px">' + esc(agentName(x.ask.by)) + ' · ' + ago(x.ask.ts) + '</td><td style="font-size:13px">' + (VERDICT[v] ? decision(VERDICT[v]) + ' ' : '') + esc(x.answer.summary) + '<br><span class="subtle">' + esc(agentName(x.answer.by)) + ' · ' + ago(x.answer.ts) + '</span></td></tr>'; });
        render('decisions', ['Decisions'], head('Decisions', 'When an agent calls logmem_ask it stops and waits here. Answers are written to the log as decided.') +
          (d.waiting.length ? d.waiting.map(askCard).join('') : emptyState('Nothing waiting on you.', 'Asks show here with the exact action and whether it can be undone.')) +
          '<div class="lm-alert" style="background:var(--surface-sunken)">' + icon('info') + '<div style="font-size:13px">Approve, Reject or Defer writes a decided entry signed by you to the ask’s log and the agent’s log, and the agent sees the verdict in its Brief. Agents cannot write decided themselves. An ask that can’t be undone needs you to type approve first.</div></div>' +
          '<h2 class="lm-title-2" style="margin:0;font-size:17px">Decided</h2>' + (hist.length ? table(['Asked', 'By', 'Answer'], hist) : emptyState('Nothing decided yet.', '')), d.waiting.length);
      });
    },
    recall: function (q) {
      var query = q ? decodeURIComponent(q) : '';
      var draw = function (d) {
        var res = (d && d.results || []).map(function (r) { return '<article class="lm-recall"><div class="lm-row"><span class="lm-kind">' + esc(r.kind) + '</span><span class="mono subtle" style="font-size:12px">' + esc(r.from) + '</span><span style="margin-left:auto;font-size:12px" class="muted">' + new Date(r.ts).toUTCString().slice(5, 22) + ' · ' + ago(r.ts) + '</span></div><blockquote style="margin:0;padding:8px 12px;border-left:3px solid var(--border-strong);background:var(--surface-sunken);font-size:14px">' + esc(r.summary) + '</blockquote><div class="lm-row subtle" style="font-size:12px"><span>trail ' + esc(r.trail || '') + '</span></div></article>'; }).join('');
        render('recall', ['Recall'], head('Recall', 'Find something nobody remembers writing. Every result quotes the original entry.') +
          '<form id="rform" role="search" style="display:flex;gap:8px;flex-wrap:wrap"><input class="lm-input" name="q" aria-label="Recall" value="' + esc(query) + '" placeholder="what did we decide about…" style="flex:1 1 420px;height:44px;font-size:15px"><button class="lm-btn lm-btn--primary" style="height:44px">Recall</button></form>' +
          '<div class="lm-alert lm-alert--info">' + icon('info') + '<div style="font-size:13px"><strong>Matching by words.</strong> No meaning-based index is attached to this space yet, so results contain your words.</div></div>' +
          (query ? (res ? '<section class="lm-panel">' + res + '</section>' : emptyState('No matches.', 'Try fewer or different words.')) : ''));
        var f = document.getElementById('rform'); if (f) f.onsubmit = function (e) { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(f.q.value); };
      };
      return query ? api('recall', { q: query }).then(function (d) { if (ok(d)) draw(d); }) : Promise.resolve(draw(null));
    },
    settings: function () {
      return api('settings').then(function (d) {
        if (!ok(d)) return;
        render('settings', ['Settings'], head('Settings') + panel('Space', kv({ space: d.space, keys: d.keys })) + panel('Storage', '<div style="display:flex;flex-direction:column;gap:10px">' + fresh('fresh', 'PING ' + d.ping_ms + ' ms') + '<span style="font-size:13px" class="muted">Your Redis, over the deploy’s bridge connection. The web app reads only; it cannot write.</span></div>') + panel('ACMI compatibility', kv({ 'compatibility mode': d.compat ? 'on' : 'off', 'mirror to ACMI': d.mirror ? 'on for ' + d.mirror_spaces.join(', ') : 'off' })) +
          '<div class="lm-alert" style="background:var(--surface-sunken)">' + icon('info') + '<div style="font-size:13px">Connections, rules and disconnecting storage are designed but not built in the web app yet.</div></div>');
      });
    },
    audit: function () {
      return api('audit').then(function (d) {
        if (!ok(d)) return;
        var g = d.gate || {};
        var last7 = (d.days || []).slice(-7);
        var strip = Array.from({ length: 7 }, function (_, i) { var x = last7[i - (7 - last7.length)]; var st = !x ? 'background:var(--surface-sunken);color:var(--text-subtle)' : x.pass ? 'background:var(--success-subtle);color:var(--success)' : 'background:var(--danger-subtle);color:var(--danger)'; return '<div style="display:flex;flex-direction:column;align-items:center;padding:10px 4px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:12px;' + st + '"><span>' + (x ? esc(x.date.slice(5)) : '—') + '</span><span>' + (x ? (x.pass ? 'PASS' : 'FAIL') : '—') + '</span></div>'; }).join('');
        var rows = (d.days || []).slice().reverse().map(function (x) { return '<tr style="font-variant-numeric:tabular-nums"><td>' + esc(x.date) + '</td><td><span class="lm-badge lm-badge--' + (x.pass ? 'success' : 'danger') + '">' + (x.pass ? 'Pass' : x.health_pass ? 'Low volume' : 'Fail') + '</span></td><td>' + num((x.agents || []).length) + '</td><td>' + num(x.entries) + '</td><td>' + num(x.accepted) + ' / ' + num(x.handoffs) + '</td><td>' + (x.mirror_checked ? num(x.mirror_mismatches) : 'n/a') + '</td><td>' + num(x.unanswered_24h) + '</td><td>' + num(x.degraded_sessions) + '</td></tr>'; });
        render('audit', ['Audit'], head('Audit', 'The daily check that nothing was lost or left hanging. Each run writes a checkup entry to job:logmem-dogfood.') +
          '<section class="lm-panel" style="padding:20px;display:flex;flex-wrap:wrap;gap:24px;align-items:center"><div style="flex:1 1 280px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">7-day gate</span><span style="font-size:22px;font-weight:600">' + (g.pass ? 'Pass' : 'Not yet: ' + (g.days_passing || 0) + ' of last 7 passing') + '</span><span style="font-size:13px" class="muted">Needs 7 consecutive passing days and the deliverable done.</span></div><div style="flex:2 1 420px;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">' + strip + '</div><div style="flex:1 1 200px;display:flex;flex-direction:column;gap:6px"><span class="lm-eyebrow">Deliverable</span>' + stage((d.deliverable || {}).stage) + '<span class="mono subtle" style="font-size:12px">job:' + esc((d.deliverable || {}).job || '') + '</span></div></section>' +
          (rows.length ? table(['Day', 'Result', 'Agents', 'Entries', 'Handoffs accepted', 'Mirror mismatches', 'Unanswered >24h', 'Degraded'], rows) : emptyState('No checks yet.', 'The first daily check writes its result here.')));
      });
    }
  };

  var VERDICT = { approve: 'approved', reject: 'rejected', defer: 'deferred' };
  function askCard(a) {
    var p = a.payload || {};
    var foot = '<div class="lm-approval-foot" data-ask="' + esc(a.trail) + '"' + (p.reversible !== true ? ' data-irreversible="1"' : '') + '>' +
      '<input class="lm-input" name="note" maxlength="1000" autocomplete="off" placeholder="Note for the agent (optional)" aria-label="Note for the agent" style="flex:1 1 220px;width:auto">' +
      '<button type="button" class="lm-btn lm-btn--primary" data-verdict="approve">Approve</button>' +
      '<button type="button" class="lm-btn lm-btn--danger" data-verdict="reject">Reject</button>' +
      '<button type="button" class="lm-btn lm-btn--secondary" data-verdict="defer">Defer</button>' +
      '<span class="lm-decide-msg" role="status" style="flex-basis:100%;font-size:13px"></span></div>';
    return '<section class="lm-approval" aria-label="Decision"><div class="lm-approval-head">' + icon('decisions') + '<strong>' + esc(agentName(a.by)) + ' asks: ' + esc(a.summary) + '</strong><span style="margin-left:auto">' + (a.deferred ? decision('deferred') : decision('pending')) + '</span></div><div class="lm-approval-body"><div class="lm-eyebrow">Exact proposed action</div><pre class="lm-action">' + esc(p.action || '(not given)') + '</pre><dl class="lm-kv"><dt>Where</dt><dd>' + esc(a.where) + '</dd><dt>Asked</dt><dd>' + ago(a.ts) + ' via ' + esc(a.via || '') + '</dd><dt>Reversible</dt><dd>' + (p.reversible === true ? 'Yes' : p.reversible === false ? 'No' : 'Not stated (treated as no)') + '</dd><dt>trail</dt><dd class="mono">' + esc(a.trail) + '</dd>' + (a.deferred ? '<dt>Deferred</dt><dd>' + ago(a.deferred.at) + ' by ' + esc(String(a.deferred.by || '').replace(/^human:/, '')) + (a.deferred.note ? ': ' + esc(a.deferred.note) : '') + ' (still open)</dd>' : '') + '</dl></div>' + foot + '</section>';
  }

  // ─── answering an ask (the web app's one write) ──────────────────
  function onDecideClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-verdict]') : null;
    if (!btn || btn.disabled) return;
    var foot = btn.closest('[data-ask]');
    if (!foot) return;
    var trail = foot.getAttribute('data-ask');
    var verdict = btn.getAttribute('data-verdict');
    var noteEl = foot.querySelector('input[name="note"]');
    var note = noteEl ? noteEl.value.trim().slice(0, 1000) : '';
    var go = function (confirmed) { sendDecision(foot, btn, trail, verdict, note, confirmed); };
    // Anything not explicitly reversible needs the typed confirmation (the server enforces it too).
    if (verdict === 'approve' && foot.getAttribute('data-irreversible') === '1') confirmIrreversible(foot, function () { go(true); });
    else go(false);
  }
  // Irreversible asks: show the exact action again and require typing "approve".
  function confirmIrreversible(foot, go) {
    var card = foot.closest('.lm-approval');
    var actionEl = card ? card.querySelector('.lm-action') : null;
    var scrim = document.createElement('div');
    scrim.className = 'lm-scrim';
    scrim.style.cssText = 'position:fixed;inset:0;z-index:50';
    scrim.innerHTML = '<div class="lm-dialog" role="dialog" aria-modal="true" aria-labelledby="lm-dlg-t"><div class="lm-dialog-head"><h2 class="lm-title-2" id="lm-dlg-t" style="margin:0;font-size:17px">This can’t be undone</h2><span style="font-size:13px" class="muted">If you approve, the agent does exactly this:</span></div>' +
      '<div class="lm-dialog-body" style="display:flex;flex-direction:column;gap:12px"><pre class="lm-action"></pre><label class="lm-field"><span class="lm-label">Type approve to confirm</span><input class="lm-input" autocomplete="off" spellcheck="false" aria-describedby="lm-dlg-t"></label></div>' +
      '<div class="lm-dialog-foot"><button type="button" class="lm-btn lm-btn--secondary" data-x="cancel">Cancel</button><button type="button" class="lm-btn lm-btn--primary" data-x="ok" disabled>Approve</button></div></div>';
    scrim.querySelector('pre').textContent = actionEl ? actionEl.textContent : '';
    var input = scrim.querySelector('input');
    var okB = scrim.querySelector('[data-x="ok"]');
    var typed = function () { return input.value.trim().toLowerCase() === 'approve'; };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    var close = function () { document.removeEventListener('keydown', onKey); if (scrim.parentNode) scrim.parentNode.removeChild(scrim); };
    var confirm = function () { if (!typed()) return; close(); go(); };
    input.oninput = function () { okB.disabled = !typed(); };
    input.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); confirm(); } };
    okB.onclick = confirm;
    scrim.querySelector('[data-x="cancel"]').onclick = close;
    scrim.onclick = function (e) { if (e.target === scrim) close(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(scrim);
    input.focus();
  }
  function sendDecision(foot, btn, trail, verdict, note, confirmed) {
    var btns = foot.querySelectorAll('button');
    var msg = foot.querySelector('.lm-decide-msg');
    var busy = function (on) { for (var i = 0; i < btns.length; i++) btns[i].disabled = on; if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); };
    var fail = function (text) { busy(false); if (msg) { msg.textContent = text; msg.style.color = 'var(--danger)'; } };
    busy(true);
    var body = { space: state.space, trail: trail, verdict: verdict };
    if (note) body.note = note;
    if (confirmed) body.confirm = 'approve';
    fetch('/api/decide', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': 'decide' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 201) return route_();
          if (r.status === 401) return login(j.error);
          if (r.status === 409) return fail('Already answered: ' + (j.error || 'someone decided this first') + '. Reload to see it.');
          fail('Not recorded: ' + (j.error || ('status ' + r.status)) + '. Nothing was written.');
        });
      })
      .catch(function (e) { fail('Couldn’t reach LogMem: ' + e.message + '. Nothing was written.'); });
  }

  // ─── plumbing ─────────────────────────────────────────────────────
  var lastWaiting = 0;
  function render(route, crumbs, body, waiting) {
    if (waiting != null) lastWaiting = waiting;
    root.innerHTML = shell(route, crumbs, body, lastWaiting);
    var sel = document.getElementById('space');
    if (sel) sel.onchange = function () { state.space = sel.value; try { localStorage.setItem('lm-space', state.space); } catch (e) {} route_(); };
    var so = document.getElementById('signout');
    if (so) so.onclick = function () { fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); }); };
    var j = document.getElementById('jump');
    if (j) j.onsubmit = function (e) { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(j.q.value); };
    document.title = 'LogMem · ' + (NAV.filter(function (n) { return n[0] === route; })[0] || [0, 'App'])[1];
  }
  function ok(d) {
    if (d.__status === 401) { login(d.error); return false; }
    if (d.spaces) { state.spaces = d.spaces; if (!state.space || d.spaces.indexOf(state.space) < 0) state.space = d.space; }
    if (d.__status !== 200) { root.innerHTML = '<div class="wrap" style="padding-top:48px">' + '<div class="lm-alert lm-alert--danger">' + icon('alert') + '<div><strong>Couldn’t load this page.</strong> The server said: ' + esc(d.error || d.__status) + '. Nothing on screen was changed. Try again.</div></div></div>'; return false; }
    return true;
  }
  function login(msg) {
    root.innerHTML = '<div class="wrap" style="max-width:420px;padding-top:96px;display:flex;flex-direction:column;gap:20px"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:32px;width:auto;align-self:flex-start"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:32px;width:auto;align-self:flex-start"><h1 class="lm-title-1" style="margin:0;font-size:22px">Sign in to LogMem.</h1>' +
      '<form id="lf" class="lm-panel" style="padding:20px;display:flex;flex-direction:column;gap:12px"><div class="lm-field"><label class="lm-label" for="pw">Admin password</label><input class="lm-input" id="pw" name="pw" type="password" autocomplete="current-password" required></div><p id="lerr" role="alert" style="margin:0;font-size:13px;color:var(--danger)">' + esc(msg && msg !== 'sign in required' ? msg : '') + '</p><button class="lm-btn lm-btn--primary">Sign in</button></form><p class="subtle" style="font-size:13px;margin:0">The web app reads, and records your answers to asks. Agents write through MCP.</p></div>';
    document.getElementById('lf').onsubmit = function (e) {
      e.preventDefault();
      fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }), credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (r.ok) route_(); else document.getElementById('lerr').textContent = j.error || 'Sign-in failed.'; }); });
    };
  }
  function route_() {
    var parts = (location.hash.replace(/^#\/?/, '') || 'overview').split('/');
    var page = pages[parts[0]] || pages.overview;
    page(parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : undefined).catch(function (e) { root.innerHTML = '<div class="wrap" style="padding-top:48px"><div class="lm-alert lm-alert--danger">' + icon('alert') + '<div><strong>Couldn’t reach LogMem.</strong> ' + esc(e.message) + '</div></div></div>'; });
  }
  root.addEventListener('click', onDecideClick);
  window.addEventListener('hashchange', route_);
  route_();
})();
