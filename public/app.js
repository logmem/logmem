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
  // Live app state: the last rev seen, the Needs you count, pulse status.
  var live = { rev: null, needs: 0, status: 'live', fails: 0, timer: null, pending: 0, soft: false, signedOut: false, home: null };

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
  // Live app spec: Home, Plans, Jobs, Agents, Log, then Admin. Needs you is a panel over every view.
  var NAV = [['home', 'Home', 'overview'], ['lanes', 'Lanes', 'work'], ['jobs', 'Jobs', 'work'], ['agents', 'Agents', 'agents'], ['log', 'Log', 'timeline']];
  var ADMIN = [['settings', 'Settings', 'settings', '#/settings'], ['audit', 'Audit', 'eye', '#/audit'], ['waitlist', 'Waitlist', 'globe', '#/waitlist'], ['keys', 'Agent keys', 'link', '/keys'], ['connections', 'Connections', 'link', '/connections']];
  var ROUTE_NAV = { plan: 'lanes', overview: 'home', agent: 'agents', job: 'jobs', channels: 'log', recall: 'log', decisions: 'home', blockers: 'home', more: 'more' };
  function navItem(n, route) { var cur = n[0] === (ROUTE_NAV[route] || route); return '<a href="' + (n[3] || '#/' + n[0]) + '" class="lm-nav-item"' + (cur ? ' aria-current="page" style="background:var(--brand-subtle);color:var(--brand)"' : '') + ' title="' + n[1] + '">' + icon(n[2]) + '<span>' + n[1] + '</span></a>'; }
  function shell(route, crumbs, body) {
    var demo = state.space === 'fieldnotes';
    var n = live.needs;
    var tab = function (id, label, ic) { var cur = id === (ROUTE_NAV[route] || route); return '<a href="#/' + id + '"' + (cur ? ' aria-current="page"' : '') + '>' + icon(ic) + label + '</a>'; };
    return '<div class="lmx"><nav class="lmx-rail" aria-label="LogMem">' +
      '<div class="lm-rail-brand"><a href="/" style="display:flex"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem" style="height:26px;width:auto"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem" style="height:26px;width:auto"></a></div>' +
      '<label class="lm-field" style="margin:4px 4px 12px"><span class="lm-label">Space</span><select class="lm-select" id="space">' + state.spaces.map(function (s) { return '<option' + (s === state.space ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select></label>' +
      NAV.map(function (x) { return navItem(x, route); }).join('') +
      '<div class="lmx-sep">Admin</div>' + ADMIN.map(function (x) { return navItem(x, route); }).join('') +
      '<div class="lm-rail-foot" style="margin-top:auto">' + (demo ? '<span class="lm-badge lm-badge--warning lmx-railtext">Sandbox space</span>' : '<span style="font-size:12px" class="subtle lmx-railtext">Live space</span>') + '<button type="button" class="lm-btn lm-btn--ghost lmx-railtext" id="signout" style="justify-content:flex-start">Sign out</button></div></nav>' +
      '<div class="lmx-col"><header class="lmx-head"><ol class="lm-crumbs">' + crumbs.map(function (c, i) { return (i ? '<li aria-hidden="true">/</li>' : '') + '<li' + (i === crumbs.length - 1 ? ' aria-current="page" style="color:var(--text)"' : '') + '>' + c + '</li>'; }).join('') + '</ol>' +
      '<span class="lmx-live" id="live" data-s="' + live.status + '">' + LIVE_LABEL[live.status] + '</span>' +
      '<form class="lm-search" id="jump" role="search"><i class="lm-i" data-i="search" aria-hidden="true"></i><input class="lm-input" name="q" placeholder="Recall: search the log" aria-label="Search the log" style="padding-left:32px"></form>' +
      '<button type="button" class="lmx-needs" data-open-needs data-n="' + num(n) + '" aria-label="Needs you: ' + num(n) + ' items">Needs you <b>' + num(n) + '</b></button></header>' +
      '<main class="lmx-main" id="main">' + body + '</main></div>' +
      '<nav class="lmx-tabs" aria-label="LogMem">' + tab('home', 'Home', 'overview') + '<button type="button" data-open-needs>' + icon('decisions') + 'Needs you' + (n ? '<b>' + num(n) + '</b>' : '') + '</button>' + tab('lanes', 'Lanes', 'work') + tab('jobs', 'Jobs', 'work') + tab('more', 'More', 'settings') + '</nav></div>';
  }
  function head(title, sub, right) { return '<div class="lm-row" style="justify-content:space-between"><div style="display:flex;flex-direction:column;gap:4px"><h1 class="lm-title-1" style="margin:0;font-size:22px">' + esc(title) + '</h1>' + (sub ? '<span style="font-size:13px" class="muted">' + sub + '</span>' : '') + '</div>' + (right || '') + '</div>'; }

  // ─── data ─────────────────────────────────────────────────────────
  function api(what, extra) {
    var q = new URLSearchParams(Object.assign({ what: what }, state.space ? { space: state.space } : {}, extra || {}));
    return fetch('/api/view?' + q, { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); });
  }

  // ─── pages ────────────────────────────────────────────────────────
  var pages = {
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
    },
    waitlist: function () {
      var invitesP = fetch('/api/invites', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
      return fetch('/api/waitlist', { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); }).then(function (d) {
        if (!ok(d)) return;
        return invitesP.then(function (inv) {
          return markInvited(d.rows || [], inv).then(function (invited) {
            var canInvite = !!inv;
            var counts = function (title, list, key) { return panel(title, list.length ? '<dl class="lm-kv">' + list.map(function (x) { return '<dt>' + esc(x[key]) + '</dt><dd>' + num(x.n) + '</dd>'; }).join('') + '</dl>' : '<span class="subtle" style="font-size:13px">None yet.</span>'); };
            var pending = (d.rows || []).filter(function (x, i) { return !invited[i]; }).map(function (x) { return x.email; });
            var rows = (d.rows || []).map(function (x, i) {
              var cell = !canInvite ? '—' : invited[i] ? '<span class="subtle">Invited</span>' : '<button type="button" class="lm-btn lm-btn--secondary" data-invite="' + esc(x.email) + '">Invite</button>';
              return '<tr style="font-variant-numeric:tabular-nums"><td>' + esc(x.email) + '</td><td>' + esc(x.plan || '—') + '</td><td>' + (x.agents == null ? '—' : num(x.agents)) + '</td><td>' + esc(x.utm_source || 'direct') + '</td><td>' + esc(x.referrer_host || '—') + '</td><td>' + esc(new Date(x.ts).toISOString().slice(0, 10)) + '</td><td>' + num(x.count) + '</td><td>' + cell + '</td></tr>';
            });
            var right = '<span style="display:flex;gap:8px">' + (canInvite && pending.length ? '<button type="button" class="lm-btn lm-btn--primary" id="invite-all">Invite all ' + num(pending.length) + ' not invited</button>' : '') + '<a class="lm-btn lm-btn--secondary" href="/api/waitlist?format=csv" download>Download CSV</a></span>';
            var note = canInvite ? (inv.open ? ' Sign-up is open to everyone.' : ' Invite people into the managed beta.') : ' Invites need the customer Redis on this deploy.';
            render('waitlist', ['Waitlist'], head('Waitlist', num(d.total) + ' sign-ups. Each row keeps the first visit’s source.' + note, right) +
              '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">' + counts('By source', d.by_source || [], 'source') + counts('By plan', d.by_plan || [], 'plan') + counts('By day', (d.by_day || []).slice(-14), 'day') + '</div>' +
              (rows.length ? table(['Email', 'Plan', 'Agents', 'Source', 'Referrer', 'First sign-up', 'Times', 'Beta'], rows) : emptyState('No sign-ups yet.', 'Sign-ups from /onboarding appear here.')));
            var send = function (emails, btn) {
              if (btn) btn.disabled = true;
              fetch('/api/invites', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': 'invites' }, body: JSON.stringify({ emails: emails }) })
                .then(function () { route_(); })
                .catch(function () { if (btn) btn.disabled = false; });
            };
            Array.prototype.forEach.call(document.querySelectorAll('[data-invite]'), function (b) { b.onclick = function () { send([b.getAttribute('data-invite')], b); }; });
            var all = document.getElementById('invite-all');
            if (all) all.onclick = function () { if (window.confirm('Invite ' + pending.length + ' people to the beta?')) send(pending.slice(0, 200), all); };
          });
        });
      });
    }
  };

  // ─── live app (spec 2026-10-19-logmem-live-app-design) ───────────
  // Shared parts, Home, the side panel, actions and the pulse.
  function getJSON(url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); }); }
  function postJSON(url, intent, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': intent }, body: JSON.stringify(Object.assign({ space: state.space }, body)) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; if (r.status === 401) login(j.error); if (r.status >= 300) throw new Error(j.error || ('status ' + r.status)); return j; }); });
  }
  function toast(text, err) {
    var box = document.getElementById('lmx-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'lmx-toasts'; box.className = 'lmx-toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    var t = document.createElement('div'); t.className = 'lmx-toast'; if (err) t.setAttribute('data-s', 'err'); t.textContent = text; box.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, err ? 6000 : 2600);
  }
  function btn(label, kind, attrs) { return '<button type="button" class="lm-btn lm-btn--' + kind + '" ' + attrs + '>' + label + '</button>'; }
  var WAIT = { task: 'Waits on a task for a person', decision: 'Waits on a decision', agent: 'Waits on agent', external: 'Waits on something outside the team' };
  function trailOf(job, op) { return op + ':' + job; }

  // Job card: title, plan › track, owner, what it waits on, one fix button.
  function jobCard(b, inPanel) {
    var w = b.blocked_on, t = w ? w.type : 'none';
    var why = !w ? '<span class="lmx-flag">No reason given</span> Ask the owner what it waits on.'
      : t === 'agent' ? 'Waits on <b>' + esc(w.ref || 'an agent') + '</b>: ' + esc(w.note)
      : esc(WAIT[t] || 'Waits') + ': ' + esc(w.note);
    var noteBox = function (op, ph, required) { return '<input class="lm-input" data-note-for="' + esc(trailOf(b.id, op)) + '" maxlength="300" placeholder="' + ph + '"' + (required ? ' required' : '') + ' aria-label="' + ph + '">'; };
    // In the panel the task or decision itself is shown right below, so no button for it.
    var acts = t === 'task' ? (inPanel ? '' : btn('Open steps', 'primary', 'data-open-job="' + esc(b.id) + '"'))
      : t === 'decision' ? (inPanel ? '' : btn('Answer', 'primary', 'data-open-job="' + esc(b.id) + '"'))
      : t === 'agent' ? noteBox('nudge', 'Note to the agent (optional)') + btn('Nudge', 'secondary', 'data-act="nudge" data-job="' + esc(b.id) + '" data-agent="' + esc(w.ref || '') + '"')
      : t === 'external' ? noteBox('unblock', 'Why it can move now', true) + btn('Unblock', 'secondary', 'data-act="unblock" data-job="' + esc(b.id) + '"')
      : noteBox('nudge', 'Note to the owner (optional)') + btn('Ask owner why', 'secondary', 'data-act="nudge" data-job="' + esc(b.id) + '"');
    var where = [b.plan, b.track].filter(Boolean).map(esc).join(' › ');
    return '<article class="lmx-card lmx-job" tabindex="0" data-key="job:' + esc(b.id) + '" data-w="' + t + '"><h3><a href="#/job/' + encodeURIComponent(b.id) + '" data-open-job="' + esc(b.id) + '">' + esc(b.title) + '</a></h3>' +
      '<div class="lmx-meta">' + [where, b.owner ? esc(agentName(b.owner)) : '', b.since ? 'blocked ' + ago(b.since) : ''].filter(Boolean).join(' · ') + '</div>' +
      '<div class="lmx-why">' + why + '</div>' + (acts ? '<div class="lmx-acts">' + acts + '</div>' : '') + '</article>';
  }
  // Plan card: percent done, next milestone, blocked count.
  function planCard(p) {
    var general = p.id === 'general';
    return '<a class="lmx-card lmx-plan" tabindex="0" data-key="plan:' + esc(p.id) + '" href="#/plan/' + encodeURIComponent(p.id) + '" style="text-decoration:none;color:inherit">' +
      '<div class="lmx-row" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>' + laneBadge(p.lane) + esc(general ? 'general' : p.title) + '</h3>' + (general ? '' : '<span class="lmx-pct">' + num(p.percent) + '%</span>') + '</div>' +
      (general ? '<div class="lmx-why">' + num(p.jobs) + (p.jobs === 1 ? ' job' : ' jobs') + ' to file in a plan</div>' : '<div class="lmx-bar"><i style="width:' + num(p.percent) + '%"></i></div>' +
      '<div class="lmx-meta">' + num(p.done) + ' of ' + num(p.jobs) + ' done' + (p.blocked ? ' · <b style="color:var(--warning)">' + num(p.blocked) + ' blocked</b>' : '') + (p.parked ? ' · ' + num(p.parked) + ' parked' : '') + '</div>' +
      '<div class="lmx-why">' + (p.next_milestone ? 'Next: ' + esc(p.next_milestone.title) + (p.next_milestone.date ? ' · ' + esc(p.next_milestone.date) : '') : 'No milestone set') + '</div>') + '</a>';
  }
  // Agent chip: live dot, Now, current job.
  function agentChip(a) {
    var doing = a.doing ? esc(a.doing) : '<span class="lmx-flag">No Now set</span>';
    return '<a class="lmx-card lmx-agent" tabindex="0" data-key="agent:' + esc(a.id) + '" data-p="' + esc(a.seen && a.seen.state) + '" href="#/agent/' + encodeURIComponent(a.id) + '" style="text-decoration:none;color:inherit"><span class="lmx-dot" aria-hidden="true"></span><div style="min-width:0"><h3>' + esc(a.id) + '</h3><div class="lmx-why">' + doing + '</div>' +
      '<div class="lmx-meta">' + [!a.seen || a.seen.since === 'never' ? 'never wrote' : a.seen.since === '0m' ? 'wrote just now' : 'wrote ' + esc(a.seen.since) + ' ago', a.blocked === true ? 'blocked' : ''].filter(Boolean).join(' · ') + '</div></div></a>';
  }
  // A task for a person: steps to tick, Done, Can't do with a reason.
  function taskCard(i) {
    var b = i.task, w = b.walkthrough || {}, steps = w.steps || [], done = b.steps_done || [];
    var list = steps.map(function (st, k) {
      var on = done.indexOf(k) >= 0;
      return '<li><input type="checkbox" data-step="' + k + '" data-trail="' + esc(b.trail) + '"' + (on ? ' checked' : '') + ' aria-label="Step ' + (k + 1) + ' done"><div style="min-width:0"><b>' + esc(st.title) + '</b>' + (st.detail ? '<div class="lmx-why">' + esc(st.detail) + '</div>' : '') +
        (st.cmd ? '<div class="lmx-acts" style="margin-top:4px"><code>' + esc(st.cmd) + '</code>' + btn('Copy', 'ghost', 'data-copy="' + esc(st.cmd) + '"') + '</div>' : '') + '</div></li>';
    }).join('');
    var meta = [w.time ? esc(w.time) : '', w.place ? esc(w.place) : '', w.due ? 'due ' + esc(w.due) : '', 'from ' + esc(agentName(b.by))].filter(Boolean).join(' · ');
    return '<article class="lmx-card" data-key="task:' + esc(b.trail) + '"><div class="lmx-meta">Task · ' + [i.plan, i.job].filter(Boolean).map(esc).join(' › ') + '</div><h3>' + esc(b.summary) + '</h3>' +
      '<div class="lmx-meta">' + meta + ' · ' + done.length + ' of ' + steps.length + ' steps</div>' + (steps.length ? '<ol class="lmx-steps">' + list + '</ol>' : '') +
      (w.done_when ? '<div class="lmx-why"><b>Done when:</b> ' + esc(w.done_when) + '</div>' : '') +
      (w.reply ? '<div class="lmx-acts"><span class="lmx-meta">Message for the agent:</span> ' + btn('Copy message', 'ghost', 'data-copy="' + esc(w.reply) + '"') + '</div>' : '') +
      '<div class="lmx-acts"><input class="lm-input" data-note-for="' + esc(trailOf(b.trail, 'task')) + '" maxlength="1000" placeholder="Note, or why you can’t do it" aria-label="Note for the agent">' +
      btn('Done', 'primary', 'data-task="done" data-trail="' + esc(b.trail) + '"') + btn('Can’t do', 'danger', 'data-task="cant_do" data-trail="' + esc(b.trail) + '"') + '</div></article>';
  }
  function needItem(i) { return i.type === 'task' ? taskCard(i) : '<div data-key="decision:' + esc(i.trail) + '"><div class="lmx-meta" style="margin:0 0 4px">Decision · ' + [i.plan, i.job].filter(Boolean).map(esc).join(' › ') + '</div>' + askCard(i.ask) + '</div>'; }

  pages.home = function () {
    return api('home').then(function (d) {
      if (!ok(d)) return;
      live.needs = d.needs_count; live.home = d;
      var plans = d.plans.length ? d.plans.map(planCard).join('') : emptyState('No plans yet.', 'Agents add jobs to plans with logmem_assign.');
      var blocked = d.blocked.length ? d.blocked.map(function (b) { return jobCard(b); }).join('') : emptyState('Nothing is blocked.', 'A blocked job shows here with what it waits on and a button to fix it.');
      var agents = d.agents.length ? d.agents.map(agentChip).join('') : emptyState('No agents yet.', 'Connect one from Admin, Agent keys.');
      var col = function (cls, title, n, body) { return '<section class="' + cls + '"><h2 class="lmx-colhead">' + title + (n != null ? ' <b>' + esc(n) + '</b>' : '') + '</h2><div class="lmx-stack">' + body + '</div></section>'; };
      render('home', ['Home'], '<div class="lmx-home">' + col('lmx-c-plans', 'Plans', null, plans) + col('lmx-c-blocked', 'Blocked', String(d.blocked.length), blocked) + col('lmx-c-agents', 'Agents', d.agents.filter(function (a) { return a.seen && a.seen.state === 'active'; }).length + ' live of ' + d.agents.length, agents) + '</div>');
    });
  };
  pages.overview = pages.home;
  pages.decisions = function () { location.replace('#/home'); openDrawer('needs', 'decisions'); return Promise.resolve(); };
  pages.blockers = function () { location.replace('#/home'); openDrawer('needs', 'tasks'); return Promise.resolve(); };
  pages.more = function () {
    var link = function (n) { return '<a class="lmx-card" style="text-decoration:none;color:inherit;flex-direction:row;align-items:center;gap:10px" href="' + (n[3] || '#/' + n[0]) + '">' + icon(n[2]) + '<h3>' + n[1] + '</h3></a>'; };
    render('more', ['More'], '<div class="lmx-stack">' + [['agents', 'Agents', 'agents'], ['log', 'Log', 'timeline'], ['recall', 'Recall', 'recall']].map(link).join('') + '<h2 class="lmx-colhead" style="margin-top:12px">Admin</h2>' + ADMIN.map(link).join('') + '<button type="button" class="lm-btn lm-btn--secondary" id="signout2">Sign out</button></div>');
    var so = document.getElementById('signout2'); if (so) so.onclick = function () { fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); }); };
    return Promise.resolve();
  };

  // ─── side panel: Needs you, or one job ────────────────────────────
  var drawer = null; // { kind: 'needs'|'job', id }
  function openDrawer(kind, id) { drawer = { kind: kind, id: id, last: document.activeElement }; drawRender(); }
  function closeDrawer() {
    var d = document.getElementById('lmx-drawer'), sc = document.getElementById('lmx-scrim');
    if (d) d.parentNode.removeChild(d); if (sc) sc.parentNode.removeChild(sc);
    document.body.classList.remove('lmx-pinned');
    var back = drawer && drawer.last; drawer = null;
    if (back && back.focus && document.contains(back)) back.focus();
  }
  function drawShell(title, body) {
    var d = document.getElementById('lmx-drawer');
    if (!d) {
      var sc = document.createElement('div'); sc.id = 'lmx-scrim'; sc.className = 'lmx-scrim'; sc.onclick = closeDrawer; document.body.appendChild(sc);
      d = document.createElement('aside'); d.id = 'lmx-drawer'; d.className = 'lmx-drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'lmx-dt'); document.body.appendChild(d);
      d.addEventListener('click', onAction); d.addEventListener('change', onAction); d.addEventListener('click', onDecideClick);
    }
    var pinned = document.body.classList.contains('lmx-pinned');
    d.innerHTML = '<div class="lmx-drawer-head"><button type="button" class="lmx-x lmx-back" data-close aria-label="Back">←</button><h2 id="lmx-dt">' + title + '</h2>' +
      (window.matchMedia('(min-width:1440px)').matches ? btn(pinned ? 'Unpin' : 'Pin', 'ghost', 'data-pin') : '') + '<button type="button" class="lmx-x" data-close aria-label="Close">×</button></div><div class="lmx-drawer-body">' + body + '</div>';
    if (!d.contains(document.activeElement)) { var h = d.querySelector('[data-close]'); if (h) h.focus({ preventScroll: true }); }
  }
  function drawRender() {
    if (!drawer) return Promise.resolve();
    var want = drawer;
    if (want.kind === 'needs') {
      return getJSON('/api/needs?space=' + encodeURIComponent(state.space || '')).then(function (n) {
        if (drawer !== want) return;
        if (n.__status !== 200) { drawShell('Needs you', emptyState('Could not load.', n.error || '')); return; }
        live.needs = n.count; syncCount();
        var tab = want.id === 'tasks' ? 'task' : want.id === 'decisions' ? 'decision' : 'all';
        var items = n.items.filter(function (i) { return tab === 'all' || i.type === tab; });
        var count = function (t) { return n.items.filter(function (i) { return t === 'all' || i.type === t; }).length; };
        var tb = function (id, t, label) { return '<button type="button" role="tab" data-ntab="' + id + '" aria-selected="' + (tab === t) + '">' + label + ' ' + count(t) + '</button>'; };
        drawShell('Needs you', '<div class="lmx-tabsbar" role="tablist">' + tb('all', 'all', 'All') + tb('decisions', 'decision', 'Decisions') + tb('tasks', 'task', 'Tasks') + '</div>' +
          (items.length ? items.map(needItem).join('') : emptyState('Nothing needs you.', 'When an agent asks a decision or hands you a task, it shows here.')));
      });
    }
    var id = want.id;
    return Promise.all([api('job', { id: id }), getJSON('/api/needs?space=' + encodeURIComponent(state.space || ''))]).then(function (rs) {
      if (drawer !== want) return;
      var d = rs[0], n = rs[1];
      if (d.__status !== 200) { drawShell(esc(id), emptyState('Could not load this job.', d.error || '')); return; }
      var who = d.who || {}, now = d.now || {};
      // Decisions come from the job view's open_asks: the server decides what is still open, never the browser.
      var mine = (n.items || []).filter(function (i) { return i.job === id && i.type === 'task'; })
        .concat((d.open_asks || []).map(function (a) { return { type: 'decision', trail: a.trail, job: id, plan: who.plan, ask: a }; }));
      var card = now.stage === 'blocked' ? jobCard({ id: id, title: who.title || id, plan: who.plan, track: who.track, owner: now.owner || who.owner, blocked_on: now.blocked_on, since: now.stage_at }, true) : '';
      var about = [['Plan', [who.plan, who.track].filter(Boolean).join(' › ')], ['Stage', null], ['Owner', agentName(now.owner || who.owner || '')], ['Milestone', typeof who.milestone === 'string' ? who.milestone : who.gate], ['Due', who.due], ['What', who.desc], ['Evidence', who.evidence]];
      var dl = '<dl class="lm-kv">' + about.filter(function (x) { return x[0] === 'Stage' || x[1]; }).map(function (x) { return '<dt>' + x[0] + '</dt><dd>' + (x[0] === 'Stage' ? stage(now.stage) : esc(x[1])) + '</dd>'; }).join('') + '</dl>';
      drawShell(esc(who.title || id), card + mine.map(needItem).join('') + panel('About', dl) + panel('Log', entries((d.log || []).slice(0, 30))));
    });
  }
  function syncCount() {
    var n = live.needs || 0;
    Array.prototype.forEach.call(document.querySelectorAll('.lmx-needs'), function (b) { b.setAttribute('data-n', String(n)); var x = b.querySelector('b'); if (x) x.textContent = String(n); });
    var tb = document.querySelector('.lmx-tabs [data-open-needs]');
    if (tb) { var badge = tb.querySelector('b'); if (n && !badge) { badge = document.createElement('b'); tb.appendChild(badge); } if (badge) { if (n) badge.textContent = String(n); else badge.parentNode.removeChild(badge); } }
    setTitle(lastRoute || 'home');
  }

  // ─── actions (shown at once, rolled back if the server refuses) ───
  function noteFor(key) { var el = document.querySelector('[data-note-for="' + CSS.escape(key) + '"]'); return el ? el.value.trim() : ''; }
  function onAction(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (ev.type === 'click') {
      var oj = t.closest('[data-open-job]'); if (oj) { ev.preventDefault(); openDrawer('job', oj.getAttribute('data-open-job')); return; }
      if (t.closest('[data-open-needs]')) { openDrawer('needs', 'all'); return; }
      if (t.closest('[data-close]')) { closeDrawer(); return; }
      if (t.closest('[data-pin]')) { document.body.classList.toggle('lmx-pinned'); drawRender(); return; }
      var nt = t.closest('[data-ntab]'); if (nt && drawer) { drawer.id = nt.getAttribute('data-ntab'); drawRender(); return; }
      var cp = t.closest('[data-copy]'); if (cp) { navigator.clipboard.writeText(cp.getAttribute('data-copy')).then(function () { toast('Copied'); }); return; }
      var a = t.closest('[data-act]'); if (a) return doWork(a);
      var tk = t.closest('[data-task]'); if (tk) return doTask(tk);
    }
    if (ev.type === 'change' && t.matches && t.matches('[data-step]')) return doStep(t);
  }
  function doWork(b) {
    var op = b.getAttribute('data-act'), job = b.getAttribute('data-job'), note = noteFor(trailOf(job, op));
    if (op === 'unblock' && !note) { toast('Say in one line why the job can move again.', true); var el = document.querySelector('[data-note-for="' + CSS.escape(trailOf(job, op)) + '"]'); if (el) el.focus(); return; }
    var card = b.closest('.lmx-card'); b.disabled = true;
    if (op === 'unblock' && card) card.style.opacity = '.4';
    postJSON('/api/' + op, 'work', { job: job, note: note || undefined, agent: b.getAttribute('data-agent') || undefined })
      .then(function (j) { var nb = document.querySelector('[data-note-for="' + CSS.escape(trailOf(job, op)) + '"]'); if (nb) { nb.value = ''; nb.blur(); } b.disabled = false; toast(op === 'nudge' ? 'Nudged ' + (j.to || 'the agent') + '.' : 'Unblocked. The owner sees it in their Brief.'); changed(); })
      .catch(function (e) { b.disabled = false; if (card) card.style.opacity = ''; toast('Not saved: ' + e.message, true); });
  }
  function doStep(c) {
    var want = c.checked; c.disabled = true;
    postJSON('/api/tasks', 'blockers', { action: 'step', trail: c.getAttribute('data-trail'), step: Number(c.getAttribute('data-step')), checked: want })
      .then(function () { c.disabled = false; toast(want ? 'Step saved. The agent sees your progress.' : 'Step unticked.'); })
      .catch(function (e) { c.disabled = false; c.checked = !want; toast('Not saved: ' + e.message, true); });
  }
  function doTask(b) {
    var action = b.getAttribute('data-task'), trail = b.getAttribute('data-trail'), note = noteFor(trailOf(trail, 'task'));
    if (action === 'cant_do' && !note) { toast('Say why you can’t do it, in the note box.', true); var el = document.querySelector('[data-note-for="' + CSS.escape(trailOf(trail, 'task')) + '"]'); if (el) el.focus(); return; }
    var card = b.closest('.lmx-card'); if (card) card.style.opacity = '.4'; b.disabled = true;
    postJSON('/api/tasks', 'blockers', action === 'done' ? { action: 'done', trail: trail, note: note || undefined } : { action: 'cant_do', trail: trail, reason: note })
      .then(function () { toast(action === 'done' ? 'Done. The job moves on.' : 'Sent back to the agent with your reason.'); if (card) card.style.display = 'none'; changed(); })
      .catch(function (e) { b.disabled = false; if (card) card.style.opacity = ''; toast('Not saved: ' + e.message, true); });
  }

  // ─── views: Plans, Jobs, Agents, Log (live app spec, section 4) ───
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  function isLate(due, st) { return !!due && ISO.test(due) && st !== 'done' && due < new Date().toISOString().slice(0, 10); }
  function dueTag(due, st) { return due ? (isLate(due, st) ? '<span class="lmx-flag">late · ' + esc(due) + '</span>' : 'due ' + esc(due)) : ''; }
  function waitsTag(w) { if (!w) return ''; return '<span class="lmx-wait" data-w="' + esc(w.type) + '">' + esc(w.type === 'agent' ? 'waits on ' + (w.ref || 'an agent') : { task: 'waits on a task', decision: 'waits on a decision', external: 'waits outside' }[w.type] || 'waits') + '</span>'; }
  // Per-view filters, kept for the session.
  var FILTERS = {};
  try { FILTERS = JSON.parse(sessionStorage.getItem('lm-filters') || '{}') || {}; } catch (e) {}
  function filt(view) { return FILTERS[view] || (FILTERS[view] = {}); }
  function saveFilt() { try { sessionStorage.setItem('lm-filters', JSON.stringify(FILTERS)); } catch (e) {} }
  function selectBox(view, key, label, values) {
    var cur = filt(view)[key] || '';
    return '<label class="lmx-f"><span>' + label + '</span><select class="lm-select" data-filter="' + view + ':' + key + '"><option value="">All</option>' + values.map(function (v) { return '<option' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select></label>';
  }
  function searchBox(view, ph) { return '<label class="lmx-f lmx-f-q"><span>Search</span><input class="lm-input" type="search" id="q-' + view + '" data-filter="' + view + ':q" value="' + esc(filt(view).q || '') + '" placeholder="' + ph + '"></label>'; }
  var uniq = function (xs) { return xs.filter(function (x, i) { return x && xs.indexOf(x) === i; }).sort(); };
  var redraw = {};
  function onFilter(ev) {
    var el = ev.target; if (!el || !el.getAttribute) return;
    var f = el.getAttribute('data-filter'); if (!f) return;
    var p = f.split(':'); filt(p[0])[p[1]] = el.value; saveFilt();
    if (p[1] === 'plan') delete filt(p[0]).track;
    clearTimeout(redraw.t);
    redraw.t = setTimeout(function () {
      var id = el.id, caret = el.selectionStart;
      if (redraw[p[0]]) redraw[p[0]]();
      if (id) { var n = document.getElementById(id); if (n) { n.focus(); try { n.setSelectionRange(caret, caret); } catch (e) {} } }
    }, el.tagName === 'INPUT' ? 180 : 0);
  }

  // Jobs: "Where is a given piece of work?" A board by stage, filtered.
  var BOARD = [['open', 'Open'], ['active', 'Active'], ['blocked', 'Blocked'], ['done', 'Done, last 7 days']];
  function boardCard(j) {
    return '<article class="lmx-card" tabindex="0" data-key="job:' + esc(j.id) + '"' + (j.stage === 'blocked' ? ' data-w="' + esc(j.blocked_on ? j.blocked_on.type : 'none') + '"' : '') + '><h3><a href="#/job/' + encodeURIComponent(j.id) + '" data-open-job="' + esc(j.id) + '">' + esc(j.title) + '</a></h3>' +
      '<div class="lmx-meta">' + [[j.plan, j.track].filter(Boolean).map(esc).join(' › '), j.owner ? esc(agentName(j.owner)) : '', dueTag(j.due, j.stage)].filter(Boolean).join(' · ') + '</div>' +
      (j.stage === 'blocked' ? '<div class="lmx-why">' + (j.blocked_on ? waitsTag(j.blocked_on) + ' ' + esc(j.blocked_on.note) : '<span class="lmx-flag">No reason given</span>') + '</div>' : j.last ? '<div class="lmx-why">' + esc(j.last.summary) + ' <span class="subtle">' + ago(j.last.ts) + '</span></div>' : '') + '</article>';
  }
  function drawJobs() {
    var all = (live.jobs || []).filter(function (j) { return j.milestone !== true; });
    var f = filt('jobs'), q = (f.q || '').toLowerCase(), week = Date.now() - 7 * 86400e3;
    var list = all.filter(function (j) {
      if (f.plan && j.plan !== f.plan) return false;
      if (f.track && j.track !== f.track) return false;
      if (f.owner && agentName(j.owner) !== f.owner) return false;
      if (q && (j.title + ' ' + j.id + ' ' + (j.last ? j.last.summary : '')).toLowerCase().indexOf(q) < 0) return false;
      if (j.stage === 'done' && j.stage_at && j.stage_at < week) return false;
      return true;
    });
    var tracks = uniq(all.filter(function (j) { return !f.plan || j.plan === f.plan; }).map(function (j) { return j.track; }));
    var bar = '<div class="lmx-filters">' + selectBox('jobs', 'plan', 'Plan', uniq(all.map(function (j) { return j.plan; }))) + selectBox('jobs', 'track', 'Track', tracks) + selectBox('jobs', 'owner', 'Owner', uniq(all.map(function (j) { return agentName(j.owner); }))) + searchBox('jobs', 'Title or last entry') + '</div>';
    var pick = f.stage || (list.some(function (j) { return j.stage === 'blocked'; }) ? 'blocked' : 'active');
    var chips = '<div class="lmx-stagechips" role="tablist">' + BOARD.map(function (b) { var n = list.filter(function (j) { return j.stage === b[0]; }).length; return '<button type="button" role="tab" data-stagepick="' + b[0] + '" aria-selected="' + (pick === b[0]) + '">' + b[1].split(',')[0] + ' ' + n + '</button>'; }).join('') + '</div>';
    var cols = BOARD.map(function (b) {
      var mine = list.filter(function (j) { return j.stage === b[0]; });
      return '<section class="lmx-boardcol" data-stage="' + b[0] + '"' + (pick === b[0] ? ' data-pick' : '') + '><h2 class="lmx-colhead">' + b[1] + ' <b>' + mine.length + '</b></h2><div class="lmx-stack">' + (mine.length ? mine.map(boardCard).join('') : '<p class="lmx-meta">None.</p>') + '</div></section>';
    }).join('');
    render('jobs', ['Jobs'], bar + chips + '<div class="lmx-board">' + cols + '</div>');
  }
  redraw.jobs = drawJobs;
  pages.jobs = function () { return api('jobs').then(function (d) { if (!ok(d)) return; live.jobs = d.jobs; drawJobs(); }); };
  pages.job = function (id) { return pages.jobs().then(function () { if (!drawer || drawer.id !== id) openDrawer('job', id); }); };

  // Plans: "Where are we against the plan?"
  function planRow(i) {
    return '<div class="lmx-prow" data-key="job:' + esc(i.id) + '"><a href="#/job/' + encodeURIComponent(i.id) + '" data-open-job="' + esc(i.id) + '">' + esc(i.title) + '</a>' +
      '<span>' + stage(i.stage) + '</span><span class="lmx-meta">' + [i.owner ? esc(agentName(i.owner)) : '', dueTag(i.due, i.stage)].filter(Boolean).join(' · ') + '</span><span>' + (i.stage === 'blocked' ? (i.blocked_on ? waitsTag(i.blocked_on) : '<span class="lmx-flag">No reason</span>') : '') + '</span></div>';
  }
  pages.plan = function (name) {
    return api('plan', name ? { id: name } : {}).then(function (d) {
      if (!ok(d)) return;
      if (!d.plan) { render('plan', ['Plans'], emptyState('No plans yet.', 'Agents open jobs in a plan with logmem_assign and details.plan.')); return; }
      var items = d.tracks.reduce(function (a, t) { return a.concat(t.items); }, []);
      var done = items.filter(function (i) { return i.stage === 'done'; }).length;
      var late = items.filter(function (i) { return isLate(i.due, i.stage); });
      var blocked = items.filter(function (i) { return i.stage === 'blocked'; }).length;
      var chips = '<div class="lmx-stagechips">' + d.plans.map(function (p) { return '<a href="#/plan/' + encodeURIComponent(p) + '" role="tab" aria-selected="' + (p === d.plan) + '">' + esc(p) + '</a>'; }).join('') + '</div>';
      var top = '<section class="lmx-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap"><h3 style="font-size:18px">' + laneBadge(d.lane) + esc(d.title || d.plan) + '</h3><span class="lmx-pct">' + num(d.percent) + '%</span></div><div class="lmx-bar"><i style="width:' + num(d.percent) + '%"></i></div>' +
        '<div class="lmx-meta">' + done + ' of ' + items.length + ' done' + (blocked ? ' · <b style="color:var(--warning)">' + blocked + ' blocked</b>' : '') + (late.length ? ' · <b style="color:var(--danger)">' + late.length + ' late</b>' : '') + '</div></section>';
      var toward = function (m) { return items.filter(function (i) { return i.milestone && (i.milestone === m.id || String(m.title).indexOf(i.milestone + ':') === 0); }); };
      var rail = d.milestones.length ? '<div class="lmx-rail-ms">' + d.milestones.map(function (m) {
        var mine = toward(m), mdone = mine.filter(function (i) { return i.stage === 'done'; }).length;
        return '<div class="lmx-card lmx-ms" data-key="ms:' + esc(m.id) + '"' + (m.stage === 'done' ? ' data-done' : '') + '><span class="lmx-meta mono">' + esc(m.date || 'no date') + '</span><h3>' + esc(m.title) + '</h3><div class="lmx-why">' + esc(m.criteria) + '</div><div class="lmx-meta">' + stage(m.stage) + (mine.length ? ' · ' + mdone + '/' + mine.length + ' jobs' : '') + '</div></div>';
      }).join('') + '</div>' : '';
      var tracks = d.tracks.map(function (t) {
        var groups = {}; t.items.forEach(function (i) { var k = i.milestone || 'No milestone'; (groups[k] = groups[k] || []).push(i); });
        var keys = Object.keys(groups).sort(function (a, b) { return (a === 'No milestone') - (b === 'No milestone') || a.localeCompare(b); });
        var tdone = t.items.filter(function (i) { return i.stage === 'done'; }).length;
        var msName = function (k) { var m = d.milestones.filter(function (x) { return x.id === k; })[0]; return m ? m.title + (m.date ? ' · ' + m.date : '') : k; };
        return '<section class="lmx-card lmx-track" data-key="track:' + esc(t.title) + '"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><h3>' + esc(t.title) + '</h3><span class="lmx-meta">' + tdone + '/' + t.items.length + ' · ' + num(t.percent) + '%</span></div><div class="lmx-bar"><i style="width:' + num(t.percent) + '%"></i></div>' +
          keys.map(function (k) { return '<div class="lmx-pgroup"><div class="lmx-colhead" style="margin:10px 0 4px">' + esc(msName(k)) + '</div>' + groups[k].map(planRow).join('') + '</div>'; }).join('') + '</section>';
      }).join('');
      render('plan', ['Plans', esc(d.title || d.plan)], chips + top + rail + (late.length ? '<section class="lmx-card"><h3>Late</h3>' + late.map(planRow).join('') + '</section>' : '') + '<div class="lmx-stack">' + tracks + '</div>');
    });
  };

  // Agents: "Who is doing what, and are they healthy?"
  function agentCard(a) {
    var now = a.now || {}, r = a.recap;
    var check = function (okv, text) { return '<li data-ok="' + (okv ? '1' : '0') + '">' + (okv ? '✓ ' : '✗ ') + text + '</li>'; };
    return '<article class="lmx-card" tabindex="0" data-key="agent:' + esc(a.id) + '"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><a href="#/agent/' + encodeURIComponent(a.id) + '" style="text-decoration:none;color:inherit">' + agent('agent:' + a.id) + '</a>' + seenTag(a.seen) + '</div>' +
      '<div class="lmx-why"><b>Now:</b> ' + (now.doing ? esc(now.doing) : '<span class="lmx-flag">No Now set</span>') + '</div>' +
      (now.job || now.next ? '<div class="lmx-meta">' + [now.job ? 'job ' + esc(typeof now.job === 'string' ? now.job : JSON.stringify(now.job)) : '', now.next ? 'next: ' + esc(now.next) : ''].filter(Boolean).join(' · ') + '</div>' : '') +
      (r ? '<div class="lmx-why"><b>Last recap:</b> ' + esc(r.summary) + ' <span class="subtle">' + ago(r.ended_at) + '</span></div>' : '') +
      '<ul class="lmx-checks">' + check(a.seen && a.seen.state === 'active', 'wrote in the last 15 min') + check(!!now.doing, 'keeps Now set') + check(!!r, 'leaves recaps') + '</ul></article>';
  }
  pages.agents = function () {
    return api('agents').then(function (d) {
      if (!ok(d)) return;
      var live_ = d.agents.filter(function (a) { return a.seen.state === 'active'; }).length;
      render('agents', ['Agents'], '<div class="lmx-filters"><span class="lmx-meta">' + live_ + ' of ' + d.agents.length + ' wrote in the last 15 minutes.</span><span class="lm-spacer"></span><a href="/keys" class="lm-btn lm-btn--secondary" style="text-decoration:none">Agent keys</a></div><div class="lmx-grid">' + d.agents.map(agentCard).join('') + '</div>');
    });
  };

  // Log: "What exactly happened?" The full record, filtered, with Recall on top.
  function drawLog(recall) {
    var all = live.log || [], f = filt('log'), q = (f.q || '').toLowerCase();
    var list = all.filter(function (e) {
      if (f.where && String(e.where || '').indexOf(f.where + ':') !== 0 && e.where !== f.where) return false;
      if (f.agent && agentName(e.by) !== f.agent) return false;
      if (f.kind && e.group !== f.kind) return false;
      if (q && String(e.summary || '').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var places = ['job', 'channel', 'agent'].concat(uniq(all.map(function (e) { return /^channel:/.test(e.where || '') ? e.where : null; })));
    var bar = '<form class="lmx-filters" id="rform2" role="search"><label class="lmx-f lmx-f-q"><span>Recall</span><input class="lm-input" name="q" value="' + esc(recall ? recall.q : '') + '" placeholder="what did we decide about…"></label><button class="lm-btn lm-btn--primary" style="align-self:flex-end">Recall</button></form>' +
      '<div class="lmx-filters">' + selectBox('log', 'where', 'Where', places) + selectBox('log', 'agent', 'Who', uniq(all.map(function (e) { return agentName(e.by); }))) + selectBox('log', 'kind', 'Kind', uniq(all.map(function (e) { return e.group; }))) + searchBox('log', 'Words in the entry') + '</div>';
    var rec = recall ? '<section class="lmx-card"><h3>Recall: “' + esc(recall.q) + '”</h3>' + (recall.results.length ? recall.results.map(function (r) { return '<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto"><div><span class="lm-kind">' + esc(r.kind) + '</span> ' + esc(r.summary) + '<div class="lmx-meta mono">' + esc(r.from) + ' · trail ' + esc(r.trail || '') + '</div></div><span class="lmx-meta">' + ago(r.ts) + '</span></div>'; }).join('') : '<p class="lmx-meta">No matches. Try fewer or different words.</p>') + '</section>' : '';
    render('log', ['Log'], bar + rec + '<section class="lm-panel" style="padding:8px 16px 16px">' + (list.length ? entries(list) : emptyState('Nothing matches.', 'Clear a filter to see more.')) + '<p class="lmx-meta">' + list.length + ' of ' + all.length + ' recent entries.</p></section>');
    var rf = document.getElementById('rform2'); if (rf) rf.onsubmit = function (e) { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(rf.q.value); };
  }
  redraw.log = function () { drawLog(live.recall); };
  pages.log = function () { live.recall = null; return api('log').then(function (d) { if (!ok(d)) return; live.log = d.entries; drawLog(null); }); };
  pages.recall = function (q) {
    var query = q || '';
    return Promise.all([api('log'), query ? api('recall', { q: query }) : Promise.resolve({ results: [] })]).then(function (rs) {
      if (!ok(rs[0])) return;
      live.log = rs[0].entries; live.recall = query ? { q: query, results: rs[1].results || [] } : null; drawLog(live.recall);
    });
  };
  pages.channels = function (id) { filt('log').where = id ? 'channel:' + id : 'channel'; saveFilt(); return pages.log(); };

  document.addEventListener('change', onFilter);
  document.addEventListener('input', function (e) { if (e.target && e.target.type === 'search') onFilter(e); });
  document.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-stagepick]') : null; if (b) { filt('jobs').stage = b.getAttribute('data-stagepick'); saveFilt(); drawJobs(); } });

  // ─── Lanes board (lanes spec): every plan as a lane, P0 first ─────
  var LANE_LABEL = { p0: 'P0', active: 'Active', parked: 'Parked' };
  function laneBadge(l) { return l && l.status ? '<span class="lmx-lane" data-l="' + esc(l.status) + '">' + LANE_LABEL[l.status] + '</span> ' : ''; }
  function laneActs(l) {
    var st = l.lane ? l.lane.status : null, id = esc(l.id), acts = [];
    if (st !== 'p0') acts.push(btn('Make P0', 'secondary', 'data-lane-act="p0" data-plan="' + id + '"'));
    if (st === 'parked') acts.push(btn('Unpark', 'primary', 'data-lane-act="active" data-plan="' + id + '"'));
    if (st !== 'parked' && l.id !== 'general') acts.push('<input class="lm-input" data-note-for="lane:' + id + '" maxlength="300" placeholder="Why park it" aria-label="Why park this lane">' + btn('Park', 'secondary', 'data-lane-act="parked" data-plan="' + id + '"'));
    if (!st && l.id !== 'general') acts.unshift(btn('Make active', 'secondary', 'data-lane-act="active" data-plan="' + id + '"'));
    return '<div class="lmx-acts">' + acts.join('') + '</div>';
  }
  function laneJobRow(j) { return '<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto" data-key="job:' + esc(j.id) + '"><a href="#/job/' + encodeURIComponent(j.id) + '" data-open-job="' + esc(j.id) + '">' + esc(j.title) + '</a><span class="lmx-meta">' + esc(agentName(j.owner || '')) + (j.since ? ' · ' + ago(j.since) : '') + '</span></div>'; }
  function parkedRow(j) { var b = j.blocked_on || {}; return '<div class="lmx-prow" style="grid-template-columns:minmax(0,1fr) auto" data-key="job:' + esc(j.id) + '"><div><a href="#/job/' + encodeURIComponent(j.id) + '" data-open-job="' + esc(j.id) + '">' + esc(j.title) + '</a><div class="lmx-meta">' + esc(b.note || '') + '</div></div><span class="lmx-meta">' + (b.until ? 'until ' + esc(b.until) : '') + (j.owner ? ' · ' + esc(agentName(j.owner)) : '') + '</span></div>'; }
  function laneCard(l, big) {
    var ln = l.lane || {};
    var head = '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap"><h3' + (big ? ' style="font-size:20px"' : '') + '>' + laneBadge(ln) + '<a href="#/plan/' + encodeURIComponent(l.id) + '" style="color:inherit;text-decoration:none">' + esc(l.title) + '</a></h3><span class="lmx-pct">' + num(l.percent) + '%</span></div>';
    var meta = '<div class="lmx-meta">' + [ln.owner ? 'driven by ' + esc(ln.owner) : '', num(l.done) + ' of ' + num(l.jobs) + ' done', l.active_count ? num(l.active_count) + ' active' : '', l.blocked_count ? '<b style="color:var(--warning)">' + num(l.blocked_count) + ' blocked</b>' : '', l.parked_jobs.length ? num(l.parked_jobs.length) + ' parked' : ''].filter(Boolean).join(' · ') + '</div>';
    var why = ln.status === 'parked' ? '<div class="lmx-why"><b>Parked:</b> ' + esc(ln.why || '') + (ln.until ? ' <b>Until:</b> ' + esc(ln.until) : '') + '</div>' : ln.why ? '<div class="lmx-why">' + esc(ln.why) + '</div>' : '';
    var next = l.next_milestone ? '<div class="lmx-why">Next: ' + esc(l.next_milestone.title) + (l.next_milestone.date ? ' · ' + esc(l.next_milestone.date) : '') + '</div>' : '';
    var moving = big && l.active.length ? '<div class="lmx-colhead" style="margin:8px 0 2px">Moving now</div>' + l.active.map(laneJobRow).join('') : '';
    var parked = l.parked_jobs.length && ln.status !== 'parked' ? '<details' + (big ? ' open' : '') + '><summary class="lmx-meta" style="cursor:pointer;margin-top:6px">Parked inside this lane (' + l.parked_jobs.length + ')</summary>' + l.parked_jobs.map(parkedRow).join('') + '</details>' : '';
    return '<section class="lmx-card lmx-lanecard" data-key="lane:' + esc(l.id) + '" data-l="' + esc(ln.status || 'none') + '">' + head + '<div class="lmx-bar"><i style="width:' + num(l.percent) + '%"></i></div>' + meta + why + next + moving + parked + laneActs(l) + '</section>';
  }
  pages.lanes = function () {
    return api('lanes').then(function (d) {
      if (!ok(d)) return;
      var by = function (st) { return d.lanes.filter(function (l) { return (l.lane ? l.lane.status : null) === st && l.id !== 'general'; }); };
      var p0 = by('p0'), act = by('active'), park = by('parked'), none = d.lanes.filter(function (l) { return !l.lane || !l.lane.status || l.id === 'general'; });
      var sec = function (title, n, body) { return '<section><h2 class="lmx-colhead">' + title + ' <b>' + n + '</b></h2>' + body + '</section>'; };
      render('lanes', ['Lanes'],
        (p0.length ? laneCard(p0[0], true) : '<div class="lm-alert lm-alert--warning">' + icon('alert') + '<div>No P0 lane is set. Pick one below with <b>Make P0</b>.</div></div>') +
        sec('Active', act.length, act.length ? '<div class="lmx-grid">' + act.map(function (l) { return laneCard(l); }).join('') + '</div>' : '<p class="lmx-meta">No other active lanes.</p>') +
        sec('Parked', park.length, park.length ? '<div class="lmx-grid">' + park.map(function (l) { return laneCard(l); }).join('') + '</div>' : '<p class="lmx-meta">Nothing parked.</p>') +
        (none.length ? sec('No lane set', none.length, '<div class="lmx-grid">' + none.map(function (l) { return laneCard(l); }).join('') + '</div>') : ''));
    });
  };
  function doLane(b) {
    var st = b.getAttribute('data-lane-act'), plan = b.getAttribute('data-plan'), why = noteFor('lane:' + plan);
    if (st === 'parked' && !why) { toast('Say in one line why the lane parks.', true); var el = document.querySelector('[data-note-for="' + CSS.escape('lane:' + plan) + '"]'); if (el) el.focus(); return; }
    if (st === 'p0' && !window.confirm('Make ' + plan + ' the P0 lane? The current P0 lane moves to active.')) return;
    b.disabled = true;
    postJSON('/api/lane', 'work', { plan: plan, status: st, why: why || undefined })
      .then(function (j) { var nb = document.querySelector('[data-note-for="' + CSS.escape('lane:' + plan) + '"]'); if (nb) { nb.value = ''; nb.blur(); } toast('Lane ' + plan + ': ' + LANE_LABEL[st] + (j.demoted && j.demoted.length ? '. ' + j.demoted.join(', ') + ' moved to active.' : '.')); changed(); })
      .catch(function (e) { b.disabled = false; toast('Not saved: ' + e.message, true); });
  }
  document.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('[data-lane-act]') : null; if (b) doLane(b); });

  // ─── live: the pulse ──────────────────────────────────────────────
  var LIVE_LABEL = { live: 'Live', reconnecting: 'Reconnecting…', paused: 'Paused' };
  function setLive(s) { live.status = s; var el = document.getElementById('live'); if (el) { el.setAttribute('data-s', s); el.textContent = LIVE_LABEL[s]; } }
  function typing() { var a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && (a.value || a.tagName === 'SELECT')); }
  function delay() { return live.fails ? Math.min(60000, 4000 * Math.pow(2, live.fails)) : document.hidden ? 30000 : 4000; }
  function schedule(ms) { clearTimeout(live.timer); live.timer = setTimeout(pulse, ms == null ? delay() : ms); }
  function pulse() {
    if (!state.space || live.signedOut) return schedule();
    getJSON('/api/pulse?space=' + encodeURIComponent(state.space)).then(function (j) {
      if (j.__status === 401) { live.signedOut = true; return; }
      if (j.__status !== 200) throw new Error('pulse ' + j.__status);
      live.fails = 0; if (live.status !== 'live') setLive('live');
      // First pulse: take the rev and load the Needs you count (it may have failed before sign-in).
      if (live.rev == null) { live.rev = j.rev; if (lastRoute !== 'home') refreshNeeds(); }
      else if (j.rev !== live.rev) { live.rev = j.rev; changed(); }
      schedule();
    }).catch(function () { live.fails++; setLive('reconnecting'); schedule(); });
  }
  // Something changed: refresh the view and the panel, unless the person is typing.
  function changed() {
    if (typing()) { live.pending++; showPill(); return; }
    hidePill();
    live.soft = true;
    var p = route_(); if (p && p.then) p.then(function () { live.soft = false; }); else live.soft = false;
    if (drawer) drawRender();
    if (lastRoute !== 'home' && !drawer) refreshNeeds();
  }
  function refreshNeeds() { return getJSON('/api/needs?space=' + encodeURIComponent(state.space || '')).then(function (n) { if (n.__status === 200) { live.needs = n.count; syncCount(); } }); }
  function showPill() {
    var p = document.getElementById('lmx-pill');
    if (!p) { p = document.createElement('button'); p.id = 'lmx-pill'; p.type = 'button'; p.className = 'lmx-pill'; p.onclick = function () { live.pending = 0; if (document.activeElement) document.activeElement.blur(); changed(); }; document.body.appendChild(p); }
    p.textContent = '↑ ' + live.pending + ' new update' + (live.pending === 1 ? '' : 's');
  }
  function hidePill() { live.pending = 0; var p = document.getElementById('lmx-pill'); if (p) p.parentNode.removeChild(p); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) schedule(0); });
  window.addEventListener('online', function () { live.fails = 0; schedule(0); });

  // Keyboard: Escape closes the panel; j / k move through cards.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer && !document.querySelector('.lm-scrim')) { closeDrawer(); return; }
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    var scope = drawer ? document.getElementById('lmx-drawer') : document.getElementById('main');
    var cards = scope ? Array.prototype.slice.call(scope.querySelectorAll('.lmx-card[tabindex]')) : [];
    if (!cards.length) return;
    var i = cards.indexOf(document.activeElement);
    var next = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'j' ? 1 : -1)))] || cards[0];
    next.focus(); e.preventDefault();
  });

  // sha256 of each row's normalized email, compared with the invited hashes. Emails never leave this page.
  function markInvited(rows, inv) {
    if (!inv || !window.crypto || !crypto.subtle) return Promise.resolve(rows.map(function () { return false; }));
    var set = {};
    (inv.invites || []).forEach(function (x) { set[x.hash] = true; });
    return Promise.all(rows.map(function (x) {
      var e = String(x.email || '').trim().toLowerCase();
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(e)).then(function (buf) {
        var h = Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        return !!set[h];
      });
    }));
  }

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
          if (r.status === 201) { toast(verdict === 'approve' ? 'Approved. The agent sees it in its Brief.' : verdict === 'reject' ? 'Rejected. The agent picks another way.' : 'Deferred. It stays open.'); return changed(); }
          if (r.status === 401) return login(j.error);
          if (r.status === 409) return fail('Already answered: ' + (j.error || 'someone decided this first') + '. Reload to see it.');
          fail('Not recorded: ' + (j.error || ('status ' + r.status)) + '. Nothing was written.');
        });
      })
      .catch(function (e) { fail('Couldn’t reach LogMem: ' + e.message + '. Nothing was written.'); });
  }

  // ─── plumbing ─────────────────────────────────────────────────────
  var lastRoute = null;
  function render(route, crumbs, body) {
    var soft = live.soft && lastRoute === route;
    var before = soft ? keysIn(root) : null;
    var y = window.scrollY;
    var focusKey = null;
    if (soft && document.activeElement && document.activeElement.closest) { var fc = document.activeElement.closest('[data-key]'); if (fc) focusKey = fc.getAttribute('data-key'); }
    root.innerHTML = shell(route, crumbs, body);
    lastRoute = route;
    if (soft) {
      window.scrollTo(0, y);
      Array.prototype.forEach.call(root.querySelectorAll('[data-key]'), function (el) { if (!before[el.getAttribute('data-key')]) el.classList.add('lmx-new'); });
      if (focusKey) { var f = root.querySelector('[data-key="' + CSS.escape(focusKey) + '"]'); if (f) f.focus({ preventScroll: true }); }
    }
    var sel = document.getElementById('space');
    if (sel) sel.onchange = function () { state.space = sel.value; try { localStorage.setItem('lm-space', state.space); } catch (e) {} live.rev = null; route_(); refreshNeeds(); };
    var so = document.getElementById('signout');
    if (so) so.onclick = function () { fetch('/api/logout', { method: 'POST' }).then(function () { location.reload(); }); };
    var j = document.getElementById('jump');
    if (j) j.onsubmit = function (e) { e.preventDefault(); location.hash = '#/recall/' + encodeURIComponent(j.q.value); };
    setTitle(route);
  }
  function keysIn(el) { var o = {}; Array.prototype.forEach.call(el.querySelectorAll('[data-key]'), function (x) { o[x.getAttribute('data-key')] = true; }); return o; }
  function setTitle(route) {
    var label = (NAV.concat(ADMIN).filter(function (n) { return n[0] === (ROUTE_NAV[route] || route); })[0] || [0, 'App'])[1];
    document.title = (live.needs ? '(' + live.needs + ') ' : '') + 'LogMem · ' + label;
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
        .then(function (r) { return r.json().then(function (j) { if (r.ok) { live.signedOut = false; route_(); refreshNeeds(); schedule(0); } else document.getElementById('lerr').textContent = j.error || 'Sign-in failed.'; }); });
    };
  }
  function route_() {
    var parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
    var page = pages[parts[0]] || pages.home;
    return page(parts[1] ? decodeURIComponent(parts.slice(1).join('/')) : undefined).catch(function (e) { root.innerHTML = '<div class="wrap" style="padding-top:48px"><div class="lm-alert lm-alert--danger">' + icon('alert') + '<div><strong>Couldn’t reach LogMem.</strong> ' + esc(e.message) + '</div></div></div>'; });
  }
  root.addEventListener('click', onDecideClick);
  root.addEventListener('click', onAction);
  root.addEventListener('change', onAction);
  window.addEventListener('hashchange', function () { live.soft = false; route_(); });
  route_();
  // The Needs you count belongs to every view, not just Home.
  if (location.hash && !/^#\/?(home|overview)?$/.test(location.hash)) refreshNeeds();
  schedule(4000);
})();
