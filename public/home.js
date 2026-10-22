/* home.js: homepage behaviour. Connect tabs, copy buttons, the demo log and
   the build-updates form. No dependencies; everything degrades without JS. */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- connect tabs (WAI-ARIA tabs, automatic activation) ---------- */
  var tabs = $$('.h-tabs [role="tab"]');
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      var p = document.getElementById(t.getAttribute('aria-controls'));
      if (p) p.hidden = !on;
    });
    if (focus) tab.focus();
  }
  if (tabs.length) {
    selectTab(tabs[0], false);
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { selectTab(t, false); });
      t.addEventListener('keydown', function (e) {
        var j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j !== null) { e.preventDefault(); selectTab(tabs[j], true); }
      });
    });
  }

  /* ---------- copy buttons ---------- */
  var copyStatus = $('#copy-status');
  function fallbackCopy(text) {
    var ta = el('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  $$('.h-copy').forEach(function (btn) {
    var label = btn.lastChild && btn.lastChild.nodeType === 3 ? btn.lastChild : null;
    var original = label ? label.textContent : '';
    btn.addEventListener('click', function () {
      var src = document.getElementById(btn.getAttribute('data-copy'));
      if (!src) return;
      var text = src.textContent.replace(/\s+$/, '');
      var done = function (ok) {
        if (label) label.textContent = ok ? 'Copied' : 'Select and copy';
        if (ok) btn.setAttribute('data-done', ''); else btn.removeAttribute('data-done');
        if (copyStatus) copyStatus.textContent = ok ? 'Copied to clipboard.' : 'Copy failed. Select the text and copy it manually.';
        setTimeout(function () { if (label) label.textContent = original; btn.removeAttribute('data-done'); }, 2000);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
      } else {
        done(fallbackCopy(text));
      }
    });
  });

  /* ---------- build updates form: honest, nothing is sent ---------- */
  var form = $('#updates-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      $('#updates-msg').textContent = 'Thanks. Sign-ups aren’t connected yet, so nothing was sent or saved. Check back here for news.';
    });
  }

  /* ---------- demo log (Field Notes Co., demo data) ---------- */
  var log = $('#demo-log');
  if (!log) return;
  var beats = $$('.h-beat');
  var playBtn = $('#demo-play');
  var replayBtn = $('#demo-replay');
  var caption = $('#demo-caption');

  var CAPTIONS = [
    'Start: quill opens a shift. Its Brief carries forward the last Recap, so it knows where the work stopped.',
    'Note: progress is written as it happens, by whichever agent did it. tally adds the list count.',
    'Handoff: quill passes the fact-check to atlas. It stays open in atlas’s Brief until atlas accepts.',
    'Switch: someone types “logmem start atlas”. LogMem recaps quill, then starts atlas, which accepts the handoff.',
    'Ask: relay wants to send email that can’t be recalled. It shows the exact action and waits for a person.',
    'Recap: atlas goes quiet for 30 minutes, so LogMem writes its Recap. The next Brief starts here.'
  ];

  // b = beat index; t = item type
  var SCRIPT = [
    { b: 0, t: 'session', text: 'quill · shift 0412 · carried forward: last Recap' },
    { b: 0, t: 'ev', time: '08:02', k: 'system', kind: 'started', who: 'quill', via: 'claude-code', sum: 'Started a shift. Brief: last Recap, 2 open jobs, nothing waiting.', prov: ['shift quillShift-0412'] },
    { b: 1, t: 'ev', time: '08:09', k: 'work', kind: 'progress', who: 'quill', via: 'claude-code', sum: 'Outline for issue 14 done, 6 sections.', prov: ['trail draftIssue14'] },
    { b: 1, t: 'ev', time: '08:24', k: 'signal', kind: 'memo', who: 'tally', via: 'codex', sum: 'Subscriber list closed at 2,184 for issue 14.', prov: ['trail listIssue14'] },
    { b: 1, t: 'ev', time: '08:27', k: 'work', kind: 'progress', who: 'quill', via: 'claude-code', sum: 'Draft done, 1,150 words. Needs a fact-check before it goes out.', prov: ['trail draftIssue14'] },
    { b: 2, t: 'ev', time: '08:30', k: 'handoff', kind: 'handoff', who: 'quill', via: 'claude-code', sum: 'To atlas: fact-check issue 14 (4 links, 2 figures).', prov: ['to atlas', 'trail handoffIssue14'] },
    { b: 3, t: 'cmd', who: 'typed in Claude Code', text: 'logmem start atlas' },
    { b: 3, t: 'ev', time: '08:31', k: 'system', kind: 'recap', who: 'quill', via: 'claude-code', sum: 'Draft done, fact-check handed to atlas. Next: send once checked.', prov: ['reason: switch to atlas'] },
    { b: 3, t: 'session', text: 'atlas · shift 0413 · Brief: 1 handoff waiting' },
    { b: 3, t: 'ev', time: '08:31', k: 'system', kind: 'started', who: 'atlas', via: 'claude-code', sum: 'Started a shift. Brief lists quill’s handoff.', prov: ['shift atlasShift-0413'] },
    { b: 3, t: 'ev', time: '08:32', k: 'handoff', kind: 'accepted', who: 'atlas', via: 'claude-code', sum: 'Accepted the issue 14 fact-check.', prov: ['origin handoffIssue14'] },
    { b: 3, t: 'ev', time: '09:38', k: 'work', kind: 'progress', who: 'atlas', via: 'claude-code', sum: 'Fixed 2 broken links. Both figures sourced.', prov: ['trail checkIssue14'] },
    { b: 3, t: 'ev', time: '09:40', k: 'handoff', kind: 'handoff', who: 'atlas', via: 'claude-code', sum: 'To relay: issue 14 is checked and ready to send.', prov: ['to relay', 'trail handoffIssue14b'] },
    { b: 4, t: 'ask' },
    { b: 4, t: 'decide', hold: 2600 },
    { b: 4, t: 'ev', time: '10:06', k: 'work', kind: 'progress', who: 'relay', via: 'codex', sum: 'Scheduled for Tue 09:00. Approved, not sent yet.', prov: ['origin approvalIssue14'] },
    { b: 5, t: 'idle', text: '30 minutes with no calls from atlas' },
    { b: 5, t: 'ev', time: '10:36', k: 'system', kind: 'recap', who: 'atlas', via: 'claude-code', sum: 'Fact-check done; issue 14 with relay. Next: source list for issue 15.', prov: ['mode: auto', 'reason: idle 30 min'] }
  ];

  var idx = 0, timer = null, playing = false, started = false, askCard = null;

  function prov(parts) {
    var p = el('div', 'lm-prov');
    parts.forEach(function (s) { p.appendChild(el('span', null, s)); });
    return p;
  }

  function eventRow(it) {
    var row = el('div', 'lm-event');
    row.setAttribute('data-k', it.k);
    row.appendChild(el('time', 'lm-event-time time', it.time));
    var rule = el('span', 'lm-event-rule'); rule.setAttribute('aria-hidden', 'true');
    row.appendChild(rule);
    var main = el('div', 'lm-event-main');
    var line = el('div', 'lm-event-line');
    // Host first: the tool that wrote it is the main signal, the agent second.
    line.appendChild(el('span', 'lm-badge h-via', 'via ' + it.via));
    line.appendChild(el('span', 'lm-kind', it.kind));
    line.appendChild(el('strong', null, it.who));
    line.appendChild(el('span', 'lm-event-summary', it.sum));
    main.appendChild(line);
    main.appendChild(prov(it.prov || []));
    row.appendChild(main);
    return row;
  }

  function sessionRow(it) {
    var row = el('div', 'lm-session');
    var dot = el('span', 'lm-carry'); dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
    row.appendChild(el('span', 'lm-eyebrow', it.text));
    return row;
  }

  function idleRow(it) {
    var row = el('div', 'lm-session');
    row.setAttribute('data-cold', '');
    var dot = el('span', 'lm-carry'); dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
    var t = el('span', 'lm-eyebrow', it.text);
    t.style.color = 'var(--text-muted)';
    row.appendChild(t);
    return row;
  }

  function cmdRow(it, animate, next) {
    var row = el('div', 'h-cmd');
    row.appendChild(el('span', 'h-cmd-who', it.who));
    var txt = el('span', 'h-cmd-txt');
    row.appendChild(txt);
    if (!animate) { txt.textContent = it.text; return row; }
    var caret = el('span', 'h-caret'); caret.setAttribute('aria-hidden', 'true');
    row.appendChild(caret);
    var i = 0;
    (function type() {
      if (!playing) { txt.textContent = it.text; caret.remove(); return; }
      txt.textContent = it.text.slice(0, ++i);
      if (i < it.text.length) timer = setTimeout(type, 55);
      else { setTimeout(function () { caret.remove(); }, 400); next(700); }
    })();
    return row;
  }

  function askRow() {
    var card = el('section', 'lm-approval h-ask');
    card.setAttribute('aria-label', 'Decision: relay asks to email issue 14');
    var head = el('div', 'lm-approval-head');
    var ic = el('i', 'lm-i'); ic.setAttribute('data-i', 'decisions'); ic.setAttribute('aria-hidden', 'true');
    head.appendChild(ic);
    head.appendChild(el('strong', null, 'relay (via codex) asks to email issue 14 to 2,184 subscribers'));
    var status = el('span', 'h-ask-status');
    status.appendChild(decisionBadge('pending'));
    head.appendChild(status);
    card.appendChild(head);

    var body = el('div', 'lm-approval-body');
    body.appendChild(el('div', 'lm-eyebrow', 'Exact proposed action'));
    body.appendChild(el('pre', 'lm-action', 'POST /v1/campaigns/iss-14/send\naudience: list:subscribers (2,184)\nschedule: Tue 09:00 -04:00'));
    var kv = el('dl', 'lm-kv');
    [['Requested', '09:52 · job:issue-14'], ['Reversible', 'No. Sent email can’t be recalled.'], ['relay', 'Waiting. Will not act until a decision is logged.']].forEach(function (p) {
      kv.appendChild(el('dt', null, p[0]));
      var dd = el('dd', null, p[1]);
      kv.appendChild(dd);
      if (p[0] === 'relay') card._wait = dd;
    });
    body.appendChild(kv);
    card.appendChild(body);

    var foot = el('div', 'lm-approval-foot');
    [['primary', 'check', 'Approve send'], ['secondary', 'x', 'Reject'], ['ghost', 'defer', 'Defer']].forEach(function (b) {
      var btn = el('button', 'lm-btn lm-btn--' + b[0]);
      btn.type = 'button'; btn.disabled = true;
      var i = el('i', 'lm-i'); i.setAttribute('data-i', b[1]); i.setAttribute('aria-hidden', 'true');
      btn.appendChild(i); btn.appendChild(document.createTextNode(b[2]));
      foot.appendChild(btn);
    });
    foot.appendChild(el('span', 'h-wait', 'Demo: buttons are inactive'));
    card.appendChild(foot);
    card._status = status; card._foot = foot;
    return card;
  }

  function decisionBadge(state) {
    var map = { pending: ['hourglass', 'Pending decision'], approved: ['check', 'Approved by noor'] };
    var b = el('span', 'lm-decision');
    b.setAttribute('data-d', state);
    var i = el('i', 'lm-i'); i.setAttribute('data-i', map[state][0]); i.setAttribute('aria-hidden', 'true');
    b.appendChild(i); b.appendChild(document.createTextNode(map[state][1]));
    return b;
  }

  function decide() {
    if (askCard) {
      askCard._status.textContent = '';
      askCard._status.appendChild(decisionBadge('approved'));
      askCard._foot.hidden = true;
      if (askCard._wait) askCard._wait.textContent = 'Approved at 10:05 by noor. Approved isn’t sent: relay logs that separately.';
    }
    return eventRow({ time: '10:05', k: 'decision', kind: 'decided', who: 'noor', via: 'claude-web', sum: 'Approved: send issue 14 Tue 09:00.', prov: ['human', 'origin approvalIssue14'] });
  }

  // ─── Raw entry view: the last entry exactly as LogMem stores it ───────
  var rawPre = $('#demo-raw'), viewSeg = $('#demo-view'), rawMode = false, lastEv = null;
  var DAY_MS = Date.UTC(2026, 9, 13, 12, 0) - 12 * 3600000; // Oct 13, 00:00 UTC (the demo day)
  function rawOf(it) {
    var hm = String(it.time || '00:00').split(':');
    var ts = DAY_MS + (Number(hm[0]) * 60 + Number(hm[1])) * 60000;
    var e = { ts: ts, kind: it.kind, by: (it.who === 'noor' ? 'human:' : 'agent:') + it.who, via: it.via, byline: it.who + ' (via ' + it.via + ')' };
    (it.prov || []).forEach(function (p) {
      var m = /^(trail|origin|to|shift) (.+)$/.exec(p);
      if (m) e[m[1] === 'to' ? 'to' : m[1]] = m[1] === 'to' ? 'agent:' + m[2] : m[2];
    });
    e.summary = it.sum;
    return JSON.stringify(e, null, 2);
  }
  function showRaw() {
    if (!rawPre) return;
    rawPre.textContent = lastEv ? rawOf(lastEv) : 'Press Play: the newest entry shows here.';
  }
  function setView(raw) {
    rawMode = raw;
    if (rawPre) rawPre.hidden = !raw;
    if (log) log.hidden = raw;
    if (viewSeg) $$('button', viewSeg).forEach(function (b) { b.setAttribute('aria-pressed', String((b.getAttribute('data-view') === 'raw') === raw)); });
    if (raw) showRaw();
  }
  if (viewSeg && rawPre) {
    viewSeg.hidden = false;
    $$('button', viewSeg).forEach(function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view') === 'raw'); });
    });
  }

  function append(node, animate) {
    if (animate && !reduced) node.classList.add('h-in');
    log.appendChild(node);
    var top = log.scrollHeight;
    if (log.scrollTo) log.scrollTo({ top: top, behavior: animate && !reduced ? 'smooth' : 'auto' });
    else log.scrollTop = top;
  }

  function renderItem(it, animate, next) {
    switch (it.t) {
      case 'session': append(sessionRow(it), animate); break;
      case 'idle': append(idleRow(it), animate); break;
      case 'ev': lastEv = it; append(eventRow(it), animate); if (rawMode) showRaw(); break;
      case 'cmd':
        if (animate && !reduced) { append(cmdRow(it, true, next), true); return true; }
        append(cmdRow(it, false), animate); break;
      case 'ask':
        append(eventRow({ time: '09:52', k: 'decision', kind: 'approval', who: 'relay', via: 'codex', sum: 'Asks: email issue 14 to 2,184 subscribers Tue 09:00?', prov: ['trail approvalIssue14', 'status waiting'] }), animate);
        askCard = askRow();
        append(askCard, animate);
        break;
      case 'decide': append(decide(), animate); break;
    }
    return false;
  }

  function setBeat(b, finished) {
    beats.forEach(function (btn, i) {
      if (i < b || (finished && i === b)) btn.setAttribute('data-state', 'done'); else btn.removeAttribute('data-state');
      if (i === b && !finished) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
    });
    if (caption) caption.textContent = b >= 0 ? 'Step ' + (b + 1) + ' of ' + beats.length + '. ' + CAPTIONS[b] : '';
  }

  function setPlayLabel() {
    if (!playBtn) return;
    var icon = playBtn.querySelector('.lm-i');
    var label = playBtn.querySelector('span');
    var atEnd = idx >= SCRIPT.length;
    icon.setAttribute('data-i', playing ? 'pause' : (atEnd ? 'refresh' : 'arrow-right'));
    label.textContent = playing ? 'Pause' : (atEnd ? 'Play again' : 'Play');
    if (replayBtn) replayBtn.hidden = atEnd && !playing;
  }

  function stop() {
    playing = false;
    clearTimeout(timer);
    setPlayLabel();
  }

  function step() {
    if (!playing) return;
    if (idx >= SCRIPT.length) { setBeat(SCRIPT[SCRIPT.length - 1].b, true); stop(); return; }
    var it = SCRIPT[idx++];
    setBeat(it.b, false);
    var delay = it.hold || (it.t === 'session' ? 900 : it.t === 'ask' ? 1600 : 1300);
    var async = renderItem(it, true, function (d) { timer = setTimeout(step, d); });
    if (!async) timer = setTimeout(step, delay);
  }

  function reset() {
    stop();
    idx = 0; askCard = null;
    while (log.firstChild) log.removeChild(log.firstChild);
  }

  function play() {
    if (idx >= SCRIPT.length) reset();
    playing = true; started = true;
    setPlayLabel();
    step();
  }

  // Jump: show everything up to and including beat b, instantly, then pause.
  function jumpTo(b) {
    reset();
    started = true;
    while (idx < SCRIPT.length && SCRIPT[idx].b <= b) renderItem(SCRIPT[idx++], false);
    setBeat(b, true);
    if (idx >= SCRIPT.length) setBeat(b, true);
    setPlayLabel();
  }

  beats.forEach(function (btn) {
    btn.addEventListener('click', function () { jumpTo(Number(btn.getAttribute('data-beat'))); });
  });
  if (playBtn) playBtn.addEventListener('click', function () { if (playing) stop(); else play(); });
  if (replayBtn) replayBtn.addEventListener('click', function () { reset(); play(); });

  var ctl = $('#demo-ctl');
  if (ctl) ctl.hidden = false;

  // The first step (session + Start entry) ships in the HTML so the panel is
  // never blank. Count those static nodes as already rendered.
  idx = Math.min(log.querySelectorAll('[data-static]').length, SCRIPT.length);
  if (idx > 0) setBeat(0, false);

  if (reduced) {
    // No motion: show the whole day at once; Play steps through without animation.
    jumpTo(SCRIPT[SCRIPT.length - 1].b);
    log.scrollTop = 0;
  } else {
    setPlayLabel();
    var armTimer = null, io = null;
    var cleanup = function () {
      if (io) io.disconnect();
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
    var autoStart = function () {
      cleanup();
      if (started) return; // the visitor already pressed Play or a step
      started = true;
      playing = true;
      setPlayLabel();
      timer = setTimeout(step, 600);
    };
    var inView = function () {
      var r = log.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      return visible > Math.min(140, r.height * 0.25);
    };
    // Fallback for hosts where the observer doesn't fire: start once the
    // panel has stayed visible for about 800ms.
    var check = function () {
      if (started) { cleanup(); return; }
      if (inView()) {
        if (!armTimer) armTimer = setTimeout(function () { armTimer = null; if (inView()) autoStart(); else check(); }, 800);
      } else if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    };
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) autoStart(); });
      }, { threshold: 0.25, rootMargin: '0px 0px -10% 0px' });
      io.observe(log);
    }
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check, { passive: true });
    check(); // panel already in view on load
  }

  // ─── Hero: one handoff plays once (rows ship in the HTML; no JS = all shown) ───
  (function () {
    var heroLog = $('#hero-log');
    if (!heroLog || reduced) return;
    var rows = $$('.lm-event', heroLog);
    rows.forEach(function (r) { r.classList.add('h-wait-in'); });
    var i = 0;
    (function next() {
      if (i >= rows.length) return;
      rows[i].classList.remove('h-wait-in');
      rows[i].classList.add('h-in');
      i++;
      setTimeout(next, 900);
    })();
  })();
})();
