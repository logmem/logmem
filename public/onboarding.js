// onboarding.js: behaviour for /onboarding. No dependencies, no inline
// handlers, no innerHTML with data from the network (textContent only).
(function () {
  'use strict';

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function icon(name) { return el('i', { class: 'lm-i', 'data-i': name, 'aria-hidden': 'true' }); }
  function alertBox(kind, iconName, kids) {
    return el('div', { class: 'lm-alert lm-alert--' + kind }, [icon(iconName), el('div', null, kids)]);
  }
  function show(container, node) { container.textContent = ''; if (node) container.appendChild(node); }

  // ---- steps -----------------------------------------------------------------
  var STEPS = {
    choose: ['Choose how to run it', 'Cloud or your own Redis'],
    plan: ['Pick a plan', 'Proposed pricing'],
    detect: ['Detect your agents', 'Local probe, read-only'],
    waitlist: ['Join the waitlist', 'Email and agent count'],
    space: ['Name your space', 'One walled-off memory'],
    redis: ['Connect your Redis', 'Upstash or rediss://'],
    acmi: ['ACMI compatibility', 'Optional'],
    connect: ['Connect agents', 'A snippet per host'],
    first: ['First entries', 'See the log fill'],
    handoff: ['Second agent', 'Your first Handoff'],
    approver: ['Invite an approver', 'Preview']
  };
  var PATHS = {
    cloud: ['choose', 'plan', 'detect', 'waitlist'],
    byo: ['choose', 'detect', 'space', 'redis', 'acmi', 'connect', 'first', 'handoff', 'approver']
  };
  var state = { path: 'byo', i: 0, max: 0 };

  function steps() { return PATHS[state.path]; }
  function current() { return steps()[state.i]; }

  function renderRail() {
    var list = steps();
    var ol = $('#steps');
    ol.textContent = '';
    list.forEach(function (id, n) {
      var done = n < state.i, cur = n === state.i;
      var b = el('button', { type: 'button', class: 'ob-step', 'data-go': String(n) }, [
        el('span', { class: 'ob-dot', 'data-s': done ? 'done' : cur ? 'cur' : '', 'aria-hidden': 'true', text: done ? '✓' : String(n + 1) }),
        el('span', { class: 'ob-step-text' }, [
          el('span', { class: 'ob-step-title', text: STEPS[id][0] }),
          el('span', { class: 'ob-step-sub', text: STEPS[id][1] }),
          el('span', { class: 'lm-sr', text: done ? ' (done)' : n > state.max ? ' (not reached yet)' : '' })
        ])
      ]);
      b.setAttribute('aria-label', 'Step ' + (n + 1) + ': ' + STEPS[id][0] + (done ? ', done' : ''));
      if (cur) b.setAttribute('aria-current', 'step');
      if (n > state.max) b.disabled = true;
      ol.appendChild(el('li', null, [b]));
    });
    $('#count').textContent = 'Step ' + (state.i + 1) + ' of ' + list.length;
    $('#rail-now').textContent = STEPS[current()][0];
  }

  function go(n, opts) {
    var list = steps();
    state.i = Math.min(list.length - 1, Math.max(0, n));
    state.max = Math.max(state.max, state.i);
    var id = current();
    $$('[data-step]').forEach(function (s) { s.hidden = s.getAttribute('data-step') !== id; });
    renderRail();
    onEnter(id);
    if (!opts || !opts.noFocus) {
      var h = $('#h-' + id);
      window.scrollTo(0, 0);
      if (h) h.focus({ preventScroll: true });
    }
  }
  function goId(id) { var n = steps().indexOf(id); if (n >= 0) { state.max = Math.max(state.max, n); go(n); } }

  function choose(path) {
    state.path = path;
    state.max = 1;
    go(1);
  }

  function onEnter(id) {
    if (id === 'detect') startProbe();
    if (id === 'waitlist') {
      $('#wl-plan').textContent = planLabel();
      var n = pickedAgents().length;
      var a = $('#wl-agents');
      if (n && !a.dataset.touched) a.value = String(Math.max(n, 1));
    }
    if (id === 'connect') renderHosts();
  }

  // ---- plan ------------------------------------------------------------------
  var PLAN_NAMES = { free: 'Free · $0', dev: 'Dev · $19 / month', pro: 'Pro · $49 / month', team: 'Team · $99 / month', agency: 'Agency · $199 / month', enterprise: 'Enterprise · contact sales' };
  function plan() { var r = $('input[name="plan"]:checked'); return r ? r.value : 'free'; }
  // The whole card picks the plan; the radio stays the real control.
  $$('.ob-plan').forEach(function (card) {
    card.addEventListener('click', function (e) {
      if (e.target.closest('input,label,a,button')) return;
      var r = $('input[type="radio"]', card);
      r.checked = true;
      r.focus();
    });
  });
  function planLabel() { return PLAN_NAMES[plan()] + ' (proposed)'; }

  // ---- agents + probe ----------------------------------------------------------
  var AGENTS = [
    ['claude', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['gemini', 'Gemini CLI'], ['opencode', 'opencode'],
    ['aider', 'Aider'], ['goose', 'Goose'], ['cline', 'Cline'], ['windsurf', 'Windsurf']
  ];
  var found = {}; // name -> version ('' when the CLI printed none)

  function renderPicks() {
    var fs = $('#agent-picks');
    $$('.ob-agent', fs).forEach(function (n) { n.remove(); });
    AGENTS.forEach(function (a) {
      var id = 'ag-' + a[0];
      var prev = document.getElementById(id);
      var input = el('input', { type: 'checkbox', id: id, value: a[0] });
      if (prev ? prev.checked : false) input.checked = true;
      var row = el('label', { class: 'ob-agent', for: id }, [
        el('span', { class: 'lm-check' }, [input, el('span', { text: a[1] })])
      ]);
      if (Object.prototype.hasOwnProperty.call(found, a[0])) {
        row.setAttribute('data-found', '');
        row.appendChild(el('span', { class: 'lm-badge lm-badge--success', text: found[a[0]] ? 'found · ' + found[a[0]] : 'found' }));
      }
      fs.appendChild(row);
    });
  }
  function pickedAgents() { return $$('#agent-picks input:checked').map(function (i) { return i.value; }); }

  var CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  function newCode() {
    var out = '';
    var buf = new Uint8Array(16);
    while (out.length < 6) {
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length && out.length < 6; i++) if (buf[i] < 252) out += CODE_CHARS[buf[i] % 36]; // 252 = 36 * 7, no bias
    }
    return out;
  }

  var POLL_MS = 3000, POLL_FOR_MS = 10 * 60 * 1000;
  var probe = { code: null, started: 0, timer: null, tick: null, state: 'idle', delay: POLL_MS };

  function probeCommand(code) {
    var origin = location.origin;
    var canon = 'https://logmem.si';
    if (origin === canon) return 'curl -fsSL ' + canon + '/probe.sh | LOGMEM_PAIR=' + code + ' sh';
    return 'curl -fsSL ' + origin + '/probe.sh | LOGMEM_URL=' + origin + ' LOGMEM_PAIR=' + code + ' sh';
  }

  function startProbe(force) {
    if (probe.state !== 'idle' && !force) return;
    stopProbe();
    probe.code = newCode();
    probe.started = Date.now();
    probe.state = 'waiting';
    probe.delay = POLL_MS;
    $('#probe-cmd').textContent = probeCommand(probe.code);
    $('#probe-code').textContent = probe.code;
    renderProbeStatus();
    poll();
    probe.tick = setInterval(updateCountdown, 1000);
  }
  function stopProbe() {
    clearTimeout(probe.timer); probe.timer = null;
    clearInterval(probe.tick); probe.tick = null;
  }
  function remaining() { return Math.max(0, probe.started + POLL_FOR_MS - Date.now()); }
  function fmt(ms) { var s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function updateCountdown() {
    var c = $('#probe-countdown');
    if (c) c.textContent = 'Listening for ' + fmt(remaining()) + ' more';
  }

  function poll() {
    if (probe.state !== 'waiting') return;
    if (remaining() <= 0) { probe.state = 'expired'; stopProbe(); renderProbeStatus(); return; }
    var code = probe.code;
    fetch('/api/onboarding/probe?code=' + encodeURIComponent(code), { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (code !== probe.code || probe.state !== 'waiting') return null;
        if (r.status === 200) { probe.delay = POLL_MS; return r.json().then(function (j) { onProbeResult(Array.isArray(j.agents) ? j.agents : []); }); }
        if (r.status === 503) { probe.state = 'unavailable'; stopProbe(); renderProbeStatus(); return null; }
        if (r.status === 404) { probe.delay = POLL_MS; return null; }
        // A 429 still counts inside the same minute. Wait it out instead of
        // polling every 3 seconds and keeping the counter hot.
        if (r.status === 429) { probe.delay = 60000; return null; }
        throw new Error('status ' + r.status);
      })
      .catch(function () { probe.delay = POLL_MS; /* network blip: keep polling until the deadline */ })
      .then(function () {
        if (probe.state === 'waiting' && code === probe.code) probe.timer = setTimeout(poll, probe.delay || POLL_MS);
      });
  }

  function onProbeResult(agents) {
    probe.state = 'found';
    stopProbe();
    found = {};
    agents.forEach(function (a) {
      if (a && typeof a.name === 'string') found[a.name] = typeof a.version === 'string' ? a.version : '';
    });
    renderPicks();
    Object.keys(found).forEach(function (n) { var i = document.getElementById('ag-' + n); if (i) i.checked = true; });
    renderProbeStatus();
  }

  function renderProbeStatus() {
    var box = $('#probe-status');
    var s = probe.state;
    if (s === 'waiting') {
      show(box, alertBox('info', 'hourglass', [
        el('strong', { text: 'Waiting for the probe to report.' }), ' Run the command above; this page checks every 3 seconds. ',
        el('span', { class: 'ob-countdown', id: 'probe-countdown', 'aria-hidden': 'true' })
      ]));
      updateCountdown();
    } else if (s === 'found') {
      var names = Object.keys(found);
      if (!names.length) {
        show(box, alertBox('warning', 'info', [el('strong', { text: 'The probe ran and found none of the 9 CLIs on your PATH.' }), ' Pick the agents you use below.']));
      } else {
        var ul = el('ul', { class: 'ob-results' }, names.map(function (n) {
          var label = (AGENTS.filter(function (a) { return a[0] === n; })[0] || [n, n])[1];
          return el('li', null, [el('strong', { text: label }), el('span', { class: 'mono subtle', text: found[n] || 'no version' })]);
        }));
        show(box, alertBox('success', 'check', [el('strong', { text: 'Found ' + names.length + ' agent' + (names.length === 1 ? '' : 's') + ' on this machine.' }), ' They’re ticked below.', ul]));
      }
    } else if (s === 'expired') {
      var again = el('button', { type: 'button', class: 'ob-linkbtn', text: 'Get a new code' });
      again.addEventListener('click', function () { startProbe(true); });
      show(box, alertBox('warning', 'clock', [el('strong', { text: 'Stopped listening after 10 minutes.' }), ' ', again, ' and run the command again, or pick your agents below.']));
    } else if (s === 'skipped') {
      var resume = el('button', { type: 'button', class: 'ob-linkbtn', text: 'Listen again with a new code' });
      resume.addEventListener('click', function () { startProbe(true); });
      show(box, alertBox('info', 'info', ['Not listening for the probe. Tick the agents you use below. ', resume]));
    } else if (s === 'unavailable') {
      show(box, alertBox('warning', 'unplug', [el('strong', { text: 'Pairing isn’t available on this deployment.' }), ' The script still prints what it finds; tick those agents below.']));
    } else show(box, null);
  }

  $('#probe-skip').addEventListener('click', function () {
    if (probe.state === 'waiting') { probe.state = 'skipped'; stopProbe(); renderProbeStatus(); }
    var first = $('#agent-picks input');
    if (first) first.focus();
  });

  // ---- space -------------------------------------------------------------------
  var SPACE_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
  function space() { var v = $('#sp').value.trim().toLowerCase(); return SPACE_RE.test(v) ? v : 'fieldnotes'; }
  function checkSpace() {
    var v = $('#sp').value.trim().toLowerCase();
    var ok = SPACE_RE.test(v);
    $('#sp').setAttribute('aria-invalid', ok ? 'false' : 'true');
    var err = $('#sp-err');
    err.hidden = ok;
    err.textContent = ok ? '' : 'Start with a letter or number; use only a-z, 0-9, - and _.';
    $('#sp-next').disabled = !ok;
    $('#sp-echo').textContent = 'lm:' + (ok ? v : '…') + ':*';
    return ok;
  }
  $('#sp').addEventListener('input', checkSpace);

  // ---- Redis + real connection test ----------------------------------------------
  var backend = 'rest';
  function setBackend(kind) {
    backend = kind;
    $('#b-rest').setAttribute('aria-pressed', String(kind === 'rest'));
    $('#b-tcp').setAttribute('aria-pressed', String(kind === 'redis'));
    $('#f-rest').hidden = kind !== 'rest';
    $('#f-tcp').hidden = kind !== 'redis';
    resetTest();
  }
  $('#b-rest').addEventListener('click', function () { setBackend('rest'); });
  $('#b-tcp').addEventListener('click', function () { setBackend('redis'); });
  ['#ru', '#rt', '#uri'].forEach(function (s) { $(s).addEventListener('input', resetTest); });
  function resetTest() { $('#redis-next').disabled = true; show($('#test-status'), null); }

  $('#test').addEventListener('click', function () {
    var btn = this;
    var body;
    if (backend === 'rest') {
      var url = $('#ru').value.trim(), token = $('#rt').value.trim();
      if (!/^https:\/\//i.test(url) || !token) {
        show($('#test-status'), alertBox('warning', 'alert', ['Enter an https:// REST URL and its token.']));
        return;
      }
      body = { kind: 'rest', url: url, token: token };
    } else {
      var uri = $('#uri').value.trim();
      if (!/^rediss:\/\//i.test(uri)) {
        show($('#test-status'), alertBox('warning', 'alert', ['Enter a rediss:// URI (TLS).']));
        return;
      }
      body = { kind: 'redis', uri: uri };
    }
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    show($('#test-status'), alertBox('info', 'hourglass', ['Testing: PING, TYPE, EXISTS…']));
    fetch('/api/onboarding/test', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) { renderTest(res.status, res.j); })
      .catch(function () { show($('#test-status'), alertBox('danger', 'unplug', ['Couldn’t reach this site’s test endpoint. Check your connection and try again.'])); })
      .then(function () { btn.removeAttribute('aria-busy'); btn.disabled = false; });
  });

  function renderTest(status, j) {
    var box = $('#test-status');
    if (status === 429) return show(box, alertBox('warning', 'clock', ['Too many tests from this network. Wait a minute and try again.']));
    if (status === 503) return show(box, alertBox('warning', 'unplug', [el('strong', { text: 'Connection testing isn’t available on this deployment.' }), ' You can skip the test for now.']));
    if (status !== 200) return show(box, alertBox('danger', 'alert', [String(j && j.error || 'The test could not run.')]));
    var ul = el('ul', { class: 'ob-results' }, (j.results || []).map(function (r) {
      return el('li', null, [icon(r.ok ? 'check' : 'x'), el('span', { class: 'mono', text: String(r.cmd) }), el('span', { class: 'subtle', text: r.ok ? 'accepted' : j.reachable ? 'refused' : 'no answer' })]);
    }));
    if (j.ok) {
      $('#redis-next').disabled = false;
      show(box, alertBox('success', 'check', [el('strong', { text: 'Connected.' }), ' Your Redis answered all three read-only commands. Nothing was written. LogMem checks the rest of the commands it uses when an agent first connects.', ul]));
    } else if (j.reachable) {
      show(box, alertBox('warning', 'alert', [el('strong', { text: 'Reachable, but some commands were refused.' }), ' LogMem needs these; check the token’s ACL or the bridge’s command list.', ul]));
    } else {
      show(box, alertBox('danger', 'unplug', [el('strong', { text: 'Could not connect with those credentials.' }), ' Check the URL and token, and that the host is reachable from the internet.', ul]));
    }
  }

  // ---- connect: hosts + snippets ---------------------------------------------------
  var HOSTS = {
    claude: { label: 'Claude Code', where: 'Run in a terminal', tested: true, snip: function (e) { return 'claude mcp add logmem --scope user \\\n' + e.map(function (p) { return '  -e ' + p[0] + '=' + p[1] + ' \\\n'; }).join('') + '  -- npx @logmem/mcp'; } },
    codex: { label: 'Codex', where: '~/.codex/config.toml', tested: true, snip: function (e) { return '[mcp_servers.logmem]\ncommand = "npx"\nargs = ["@logmem/mcp"]\n\n[mcp_servers.logmem.env]\n' + e.map(function (p) { return p[0] + ' = "' + p[1] + '"'; }).join('\n'); } },
    cursor: { label: 'Cursor', where: '.cursor/mcp.json', tested: true, snip: jsonSnip },
    web: { label: 'Claude Web', where: 'Settings › Connectors › Add custom connector', tested: true, web: true, snip: function () { return location.origin + '/mcp'; } },
    gemini: { label: 'Gemini CLI', where: '~/.gemini/settings.json', snip: jsonSnip },
    opencode: { label: 'opencode', where: 'opencode.json', snip: function (e) { return '{\n  "mcp": {\n    "logmem": {\n      "type": "local",\n      "command": ["npx", "@logmem/mcp"],\n      "environment": {\n' + e.map(function (p, i) { return '        "' + p[0] + '": "' + p[1] + '"' + (i < e.length - 1 ? ',' : ''); }).join('\n') + '\n      }\n    }\n  }\n}'; } },
    goose: { label: 'Goose', where: '~/.config/goose/config.yaml', snip: function (e) { return 'extensions:\n  logmem:\n    type: stdio\n    cmd: npx\n    args: ["@logmem/mcp"]\n    enabled: true\n    envs:\n' + e.map(function (p) { return '      ' + p[0] + ': "' + p[1] + '"'; }).join('\n'); } },
    cline: { label: 'Cline', where: 'Cline › MCP Servers › Configure (cline_mcp_settings.json)', snip: jsonSnip },
    windsurf: { label: 'Windsurf', where: '~/.codeium/windsurf/mcp_config.json', snip: jsonSnip },
    aider: { label: 'Aider', where: 'No MCP setup yet', none: true, snip: function (e) { return e.map(function (p) { return p[0] + '=' + p[1]; }).join('\n') + '\n\nnpx @logmem/mcp'; } }
  };
  var CORE = ['claude', 'codex', 'cursor', 'web'];
  var host = null;

  function jsonSnip(e) {
    return '{\n  "mcpServers": {\n    "logmem": {\n      "command": "npx",\n      "args": ["@logmem/mcp"],\n      "env": {\n' +
      e.map(function (p, i) { return '        "' + p[0] + '": "' + p[1] + '"' + (i < e.length - 1 ? ',' : ''); }).join('\n') + '\n      }\n    }\n  }\n}';
  }

  function envPairs() {
    var e = [['LOGMEM_SPACE', space()], ['LOGMEM_AGENT', 'quill']];
    if (backend === 'redis') e.push(['LOGMEM_REDIS_URI', '<your rediss:// URI>']);
    else {
      var url = $('#ru').value.trim();
      // Only a plain https URL goes into the snippet; anything else stays a placeholder.
      e.push(['LOGMEM_REST_URL', /^https:\/\/[^\s"'\\<>]+$/i.test(url) && url.length <= 200 ? url : '<your REST URL>']);
      e.push(['LOGMEM_REST_TOKEN', '<space token>']);
    }
    if ($('#compat').checked) e.push(['LOGMEM_ACMI_COMPAT', '1']);
    if ($('#mirror').checked) { e.push(['LOGMEM_MIRROR_ACMI', '1']); e.push(['LOGMEM_MIRROR_SPACES', space()]); }
    return e;
  }

  function hostList() {
    var picked = pickedAgents();
    var extra = picked.filter(function (n) { return CORE.indexOf(n) < 0 && HOSTS[n]; });
    return CORE.concat(extra);
  }

  function renderHosts() {
    var list = hostList();
    var picked = pickedAgents();
    if (!host || list.indexOf(host) < 0) {
      var pre = list.filter(function (h) { return picked.indexOf(h) >= 0 && !HOSTS[h].none; })[0];
      host = pre || list[0];
    }
    var tl = $('#hosts');
    tl.textContent = '';
    list.forEach(function (id) {
      var sel = id === host;
      var b = el('button', { type: 'button', class: 'lm-tab', role: 'tab', id: 'tab-' + id, 'aria-controls': 'host-panel', 'aria-selected': String(sel), tabindex: sel ? '0' : '-1', 'data-host': id }, [HOSTS[id].label]);
      if (Object.prototype.hasOwnProperty.call(found, id)) b.appendChild(el('span', { class: 'lm-badge lm-badge--success' }, [el('span', { class: 'lm-sr', text: ', ' }), 'found']));
      else if (picked.indexOf(id) >= 0) b.appendChild(el('span', { class: 'lm-badge' }, [el('span', { class: 'lm-sr', text: ', ' }), 'yours']));
      tl.appendChild(b);
    });
    $('#host-panel').setAttribute('aria-labelledby', 'tab-' + host);
    renderSnippet();
  }

  function renderSnippet() {
    var h = HOSTS[host];
    $('#snip-label').textContent = h.where;
    var badges = $('#snip-badges');
    badges.textContent = '';
    if (!h.tested && !h.web) badges.appendChild(el('span', { class: 'lm-badge lm-badge--warning', text: 'Untested' }));
    $('#snip').textContent = h.snip(envPairs());
    var note = $('#snip-note');
    if (h.web) note.textContent = 'Claude asks you to sign in to LogMem and pick a space. That connection can only use that space.';
    else if (h.none) note.textContent = 'We don’t have a LogMem setup for Aider yet. Any MCP-capable wrapper can run the server with these variables.';
    else if (!h.tested) note.textContent = 'This follows ' + h.label + '’s documented MCP config format but hasn’t been tested with LogMem yet.';
    else note.textContent = backend === 'redis' ? 'Paste your rediss:// URI in place of the placeholder; this page never puts it in a snippet.' : 'Restart ' + h.label + ' after adding it.';
    $('#sim-host').textContent = h.label;
  }

  $('#hosts').addEventListener('click', function (e) {
    var t = e.target.closest('[data-host]');
    if (!t) return;
    host = t.getAttribute('data-host');
    renderHosts();
    $('#tab-' + host).focus();
  });
  $('#hosts').addEventListener('keydown', function (e) {
    var tabs = $$('[role="tab"]', this);
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    n = (n + tabs.length) % tabs.length;
    host = tabs[n].getAttribute('data-host');
    renderHosts();
    $('#tab-' + host).focus();
  });
  $('#sim').addEventListener('click', function () { $('#waiting').hidden = true; $('#connected').hidden = false; });
  ['#compat', '#mirror'].forEach(function (s) { $(s).addEventListener('change', function () { if (host) renderSnippet(); }); });

  // ---- copy ------------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var id = b.getAttribute('data-copy');
    var text = document.getElementById(id).textContent;
    var out = $('[data-copied="' + id + '"]');
    var ok = function () { out.textContent = 'Copied.'; setTimeout(function () { out.textContent = ''; }, 2500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, function () { out.textContent = 'Copy failed; select the text and copy it.'; });
    else out.textContent = 'Select the text and copy it.';
  });

  // ---- waitlist (real: stored on this deployment) -------------------------------------
  $('#wl-agents').addEventListener('input', function () { this.dataset.touched = '1'; });
  $('#wl-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('#wl-email').value.trim();
    var err = $('#wl-email-err');
    var shape = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) && email.length <= 254;
    $('#wl-email').setAttribute('aria-invalid', String(!shape));
    err.hidden = shape;
    err.textContent = shape ? '' : 'Enter a valid email address.';
    if (!shape) { $('#wl-email').focus(); return; }
    var btn = $('#wl-submit');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    var agents = parseInt($('#wl-agents').value, 10);
    fetch('/api/onboarding/waitlist', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: email, agents: Number.isFinite(agents) ? agents : null, plan: plan() })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body || {} }; });
    }).then(function (r) {
      var box = $('#wl-status');
      if (r.status === 200) {
        show(box, alertBox('success', 'check', [el('strong', { text: 'You’re on the waitlist.' }), ' We’ll email ' + email + ' when LogMem Cloud opens. Nothing is charged and no account was created.']));
      } else if (r.status === 400) {
        err.hidden = false; err.textContent = 'Enter a valid email address.'; $('#wl-email').setAttribute('aria-invalid', 'true'); $('#wl-email').focus();
        show(box, null);
      } else if (r.status === 429) {
        show(box, alertBox('warning', 'clock', ['Too many tries from this network. Wait a minute and try again.']));
      } else if (r.status === 503 && r.body.error === 'waitlist is full') {
        show(box, alertBox('warning', 'info', [el('strong', { text: 'The waitlist is full right now.' }), ' Nothing was saved.']));
      } else if (r.status === 503) {
        show(box, alertBox('warning', 'unplug', [el('strong', { text: 'The waitlist isn’t open on this deployment.' }), ' Nothing was saved.']));
      } else {
        show(box, alertBox('danger', 'alert', ['Something went wrong and nothing was saved. Please try again.']));
      }
    }).catch(function () {
      show($('#wl-status'), alertBox('danger', 'unplug', ['Couldn’t reach the server. Nothing was saved.']));
    }).then(function () { btn.removeAttribute('aria-busy'); btn.disabled = false; });
  });

  // ---- approver (Preview: nothing is sent) ----------------------------------------------
  $('#ap-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('#ap-email').value.trim();
    var ok = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v);
    $('#ap-email').setAttribute('aria-invalid', String(!ok));
    show($('#ap-status'), ok
      ? alertBox('info', 'info', [el('span', { class: 'lm-demo', text: 'Preview' }), ' No invite was sent and nothing was saved. When invites ship, ' + v + ' gets an email and every Ask in ' + space() + ' shows up in their Decisions view.'])
      : alertBox('warning', 'alert', ['Enter the approver’s email address.']));
  });

  // ---- global navigation ------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.hasAttribute('data-choose')) choose(t.getAttribute('data-choose'));
    else if (t.hasAttribute('data-next')) {
      if (current() === 'space' && !checkSpace()) return;
      go(state.i + 1);
    }
    else if (t.hasAttribute('data-back')) go(state.i - 1);
    else if (t.hasAttribute('data-goto')) goId(t.getAttribute('data-goto'));
    else if (t.hasAttribute('data-go')) go(Number(t.getAttribute('data-go')));
  });

  renderPicks();
  go(0, { noFocus: true });
})();
