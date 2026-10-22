// Agent keys: a signed-in admin creates, lists and revokes per-agent LogMem keys.
(function () {
  'use strict';
  var root = document.getElementById('root');
  var INTENT = { 'Content-Type': 'application/json', 'X-LogMem-Intent': 'agent-keys' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return ''; } }

  function signIn(msg) {
    root.innerHTML = '<h1 style="margin:0">Agent keys</h1>' +
      '<form id="lf" class="lm-panel" style="padding:20px;display:flex;flex-direction:column;gap:12px"><div class="lm-field"><label class="lm-label" for="pw">Admin password</label><input class="lm-input" id="pw" type="password" autocomplete="current-password" required></div>' +
      '<p id="lerr" role="alert" style="margin:0;font-size:13px;color:var(--danger)">' + esc(msg || '') + '</p><button class="lm-btn lm-btn--primary">Sign in</button></form>';
    document.getElementById('lf').addEventListener('submit', function (ev) {
      ev.preventDefault();
      fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }), credentials: 'same-origin' })
        .then(function (r) { if (r.ok) load(); else signIn('Wrong password.'); })
        .catch(function () { signIn('Could not reach the server.'); });
    });
  }

  function render(data, fresh, err) {
    var spaces = data.spaces || [];
    var rows = (data.keys || []).map(function (k) {
      return '<tr><td class="mono">' + esc(k.agent) + '</td><td class="mono">' + esc(k.space) + '</td><td>' + esc(k.label) + '</td><td class="muted" style="font-size:13px">' + esc(when(k.created_at)) + '</td>' +
        '<td><button class="lm-btn" data-revoke="' + esc(k.id) + '" data-agent="' + esc(k.agent) + '">Revoke</button></td></tr>';
    }).join('');
    var web = (data.web || []).map(function (a) {
      return '<tr><td>' + esc(a.app) + '</td><td class="mono">' + esc(a.agent) + '</td><td class="mono">' + esc(a.space || '') + '</td><td class="muted" style="font-size:13px">' + esc(when((a.last_used || 0) * 1000)) + '</td>' +
        '<td><button class="lm-btn" data-disconnect="' + esc(a.fid) + '" data-app="' + esc(a.app) + '">Disconnect</button></td></tr>';
    }).join('');
    root.innerHTML = '<h1 style="margin:0">Agent keys</h1>' +
      '<p class="muted" style="margin:0">One key per agent. A key works for one space and one agent name only, and never expires. Revoke it here at any time. Put each key in that agent\'s vault, never in a chat or a log.</p>' +
      (fresh ? '<section class="lm-panel" style="padding:16px;display:flex;flex-direction:column;gap:8px;border-color:var(--brand)" aria-label="New key"><strong>New key for ' + esc(fresh.agent) + '. Copy it now. It is not shown again.</strong>' +
        '<code id="nk" class="mono" style="overflow-wrap:anywhere;padding:8px;background:var(--sunken);border-radius:4px">' + esc(fresh.key) + '</code>' +
        '<div><button class="lm-btn lm-btn--primary" id="copy">Copy key</button> <button class="lm-btn" id="hide">Done, hide it</button></div></section>' : '') +
      '<form id="cf" class="lm-panel" style="padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end">' +
        '<div class="lm-field"><label class="lm-label" for="ag">Agent id</label><input class="lm-input mono" id="ag" required placeholder="muse" autocomplete="off" spellcheck="false"></div>' +
        '<div class="lm-field"><label class="lm-label" for="sp">Space</label><select class="lm-input" id="sp">' + spaces.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('') + '</select></div>' +
        '<div class="lm-field"><label class="lm-label" for="lb">Label</label><input class="lm-input" id="lb" placeholder="Muse vault, custom.logmem" maxlength="80"></div>' +
        '<button class="lm-btn lm-btn--primary">Create key</button></form>' +
      (err ? '<p role="alert" style="margin:0;color:var(--danger)">' + esc(err) + '</p>' : '') +
      '<div class="lm-panel" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr><th style="text-align:left;padding:8px">Agent</th><th style="text-align:left;padding:8px">Space</th><th style="text-align:left;padding:8px">Label</th><th style="text-align:left;padding:8px">Created</th><th></th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5" class="muted" style="padding:8px">No keys yet.</td></tr>') + '</tbody></table></div>' +
      '<h2 style="margin:8px 0 0;font-size:18px">Web connections</h2>' +
      '<p class="muted" style="margin:0">Apps such as Gemini or Claude web that you connected to a fleet space on the sign-in page. Disconnect ends every token of that connection.</p>' +
      '<div class="lm-panel" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr><th style="text-align:left;padding:8px">App</th><th style="text-align:left;padding:8px">Agent</th><th style="text-align:left;padding:8px">Space</th><th style="text-align:left;padding:8px">Last used</th><th></th></tr></thead><tbody>' +
        (web || '<tr><td colspan="5" class="muted" style="padding:8px">No web connections.</td></tr>') + '</tbody></table></div>';

    document.getElementById('cf').addEventListener('submit', function (ev) {
      ev.preventDefault();
      post({ agent: document.getElementById('ag').value, space: document.getElementById('sp').value, label: document.getElementById('lb').value })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) { if (x.ok) load(x.j); else load(null, x.j.error || 'Could not create the key.'); })
        .catch(function () { load(null, 'Could not reach the server.'); });
    });
    var copy = document.getElementById('copy');
    if (copy) copy.addEventListener('click', function () { navigator.clipboard.writeText(fresh.key).then(function () { copy.textContent = 'Copied'; }); });
    var hide = document.getElementById('hide');
    if (hide) hide.addEventListener('click', function () { load(); });
    Array.prototype.forEach.call(root.querySelectorAll('[data-disconnect]'), function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Disconnect ' + b.getAttribute('data-app') + '? Every token of this connection stops working.')) return;
        post({ action: 'disconnect', fid: b.getAttribute('data-disconnect') }).then(function () { load(); }).catch(function () { load(null, 'Could not disconnect.'); });
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-revoke]'), function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Revoke the key for ' + b.getAttribute('data-agent') + '? That agent loses access at once.')) return;
        post({ action: 'revoke', id: b.getAttribute('data-revoke') }).then(function () { load(); }).catch(function () { load(null, 'Could not revoke the key.'); });
      });
    });
  }

  function post(payload) { return fetch('/api/agent-keys', { method: 'POST', headers: INTENT, body: JSON.stringify(payload), credentials: 'same-origin' }); }

  function load(fresh, err) {
    fetch('/api/agent-keys', { credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) return signIn(); return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'error'); render(j, fresh, err); }); })
      .catch(function (e) { root.innerHTML = '<h1 style="margin:0">Agent keys</h1><p role="alert">' + esc(e.message || 'Could not load keys.') + '</p>'; });
  }
  load();
})();
