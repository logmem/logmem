// Connected apps: the signed-in LogMem account owner sees and disconnects the apps that use their memory.
(function () {
  'use strict';
  var root = document.getElementById('root');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(sec) { try { return new Date(sec * 1000).toLocaleString(); } catch (e) { return ''; } }
  var H1 = '<h1 style="margin:0">Connected apps</h1>';

  function render(d, err) {
    if (d.waitlist) {
      root.innerHTML = H1 + '<p class="muted" style="margin:0">Signed in as ' + esc(d.email) + '. You\'re on the beta waitlist. We\'ll email your invite.</p>';
      return;
    }
    var rows = (d.apps || []).map(function (a) {
      return '<tr><td>' + esc(a.app) + '</td><td class="mono">' + esc(a.agent) + '</td><td class="muted" style="font-size:13px">' + esc(when(a.last_used)) + '</td>' +
        '<td><button class="lm-btn" data-fid="' + esc(a.fid) + '" data-app="' + esc(a.app) + '">Disconnect</button></td></tr>';
    }).join('');
    root.innerHTML = H1 +
      '<p class="muted" style="margin:0">Signed in as ' + esc(d.email) + ' · plan ' + esc(d.plan) + '. These apps can read and write your LogMem memory. Disconnect one to stop it at once and free its agent slot.</p>' +
      (err ? '<p role="alert" style="margin:0;color:var(--danger)">' + esc(err) + '</p>' : '') +
      '<div class="lm-panel" style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr><th style="text-align:left;padding:8px">App</th><th style="text-align:left;padding:8px">Agent</th><th style="text-align:left;padding:8px">Last used</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4" class="muted" style="padding:8px">No apps connected yet. Add https://logmem.si/mcp in your app to connect one.</td></tr>') + '</tbody></table></div>';
    Array.prototype.forEach.call(root.querySelectorAll('[data-fid]'), function (b) {
      b.addEventListener('click', function () {
        if (!window.confirm('Disconnect ' + b.getAttribute('data-app') + '? It loses access at once.')) return;
        b.disabled = true;
        fetch('/api/connections', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-LogMem-Intent': 'connections' }, body: JSON.stringify({ action: 'disconnect', fid: b.getAttribute('data-fid') }) })
          .then(function () { load(); })
          .catch(function () { load('Could not disconnect. Try again.'); });
      });
    });
  }

  function load(err) {
    fetch('/api/connections', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json().then(function (j) {
          if (r.status === 401) {
            root.innerHTML = H1 + '<p class="muted" style="margin:0">Sign in with your LogMem account to see the apps connected to your memory.</p><p><a class="lm-btn lm-btn--primary" href="' + esc(j.signin || '/api/connections?signin=1') + '">Sign in</a></p>';
            return;
          }
          if (!r.ok) throw new Error(j.error || 'Could not load your apps.');
          render(j, err);
        });
      })
      .catch(function (e) { root.innerHTML = H1 + '<p role="alert">' + esc(e.message || 'Could not load your apps.') + '</p>'; });
  }
  load();
})();
