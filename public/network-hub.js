// network-hub.js: a small diagram of agents writing to one shared log. Demo data, clearly labelled.
// The log in the middle is the product: every agent writes to it, a person is asked before anything irreversible.
// Motion runs only while the diagram is on screen, the tab is visible and the viewer has not paused it.
// With reduced motion it draws the finished state once and stays still.

export const NODES = {
  chatgpt: { name: 'ChatGPT', role: 'planner', logo: '/home-assets/agents/chatgpt.svg', side: 'l' },
  claude: { name: 'Claude', role: 'reviewer', logo: '/home-assets/agents/claude.png', side: 'l' },
  gemini: { name: 'Gemini', role: 'researcher', logo: '/home-assets/agents/gemini.png', side: 'l' },
  cursor: { name: 'Cursor', role: 'builder', logo: '/home-assets/agents/cursor.svg', side: 'r' },
  codex: { name: 'Codex', role: 'builder', logo: '/home-assets/agents/codex.svg', side: 'r' },
  you: { name: 'You', role: 'approves', logo: '', side: 'r', human: true },
};

// Two layouts share one script. Coordinates are in each layout's own viewBox.
export const LAYOUTS = {
  wide: {
    w: 1000, h: 560, ledger: { x: 345, y: 60, w: 310, h: 440 }, node: { w: 190, h: 64 },
    pos: { chatgpt: [125, 120], claude: [125, 280], gemini: [125, 440], cursor: [875, 120], codex: [875, 280], you: [875, 440] },
    anchor: { chatgpt: [345, 160], claude: [345, 280], gemini: [345, 400], cursor: [655, 160], codex: [655, 280], you: [655, 400] },
    start: { chatgpt: [220, 120], claude: [220, 280], gemini: [220, 440], cursor: [780, 120], codex: [780, 280], you: [780, 440] },
    curve: 'side',
  },
  tall: {
    w: 360, h: 700, ledger: { x: 16, y: 176, w: 328, h: 348 }, node: { w: 104, h: 62 },
    pos: { chatgpt: [66, 70], claude: [180, 70], gemini: [294, 70], cursor: [66, 630], codex: [180, 630], you: [294, 630] },
    anchor: { chatgpt: [76, 176], claude: [180, 176], gemini: [284, 176], cursor: [76, 524], codex: [180, 524], you: [284, 524] },
    start: { chatgpt: [66, 101], claude: [180, 101], gemini: [294, 101], cursor: [66, 599], codex: [180, 599], you: [294, 599] },
    curve: 'stack',
  },
};

// The story. Each step is a few things that happen in order. Times are demo times, not real ones.
export const STEPS = [
  { by: 'chatgpt', kind: 'assigned', k: 'work', text: 'New job: draft newsletter issue 14' },
  { by: 'claude', kind: 'progress', k: 'work', text: 'Outline done, six sections' },
  { by: 'gemini', kind: 'research', k: 'signal', text: 'Three sources checked, one flagged' },
  { by: 'cursor', kind: 'handoff', k: 'handoff', text: 'Build the send script for Codex', to: 'codex' },
  { by: 'claude', kind: 'approval', k: 'decision', text: 'Send issue 14 to 2,184 readers?', ask: true },
  { by: 'claude', kind: 'done', k: 'work', text: 'Issue 14 sent. Receipt saved' },
];

const KIND_WORD = { started: 'started', accepted: 'accepted', assigned: 'assigned', progress: 'progress', research: 'research', handoff: 'handoff', approval: 'approval', decided: 'decided', done: 'done' };

const el = (tag, attrs = {}, kids = []) => {
  const n = tag === 'svg' || attrs.ns ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k !== 'ns' && v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  n.append(...kids);
  return n;
};
const svgEl = (tag, attrs = {}, kids = []) => el(tag, { ...attrs, ns: true }, kids);
const clock = n => { const m = (8 * 60 + n * 4) % (24 * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

function pathFor(layout, id) {
  const L = LAYOUTS[layout], [sx, sy] = L.start[id], [ax, ay] = L.anchor[id];
  const d = L.curve === 'side'
    ? `M${sx} ${sy} C${sx + (ax - sx) * .55} ${sy}, ${sx + (ax - sx) * .45} ${ay}, ${ax} ${ay}`
    : `M${sx} ${sy} C${sx} ${sy + (ay - sy) * .55}, ${ax} ${sy + (ay - sy) * .45}, ${ax} ${ay}`;
  return d;
}

export function mountNetworkHub(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const phone = matchMedia('(max-width: 760px)');
  let layout = phone.matches ? 'tall' : 'wide';
  let paused = false, visible = true, running = false, last = 0, rafId = 0;

  // structure
  root.classList.add('nh');
  root.replaceChildren();
  const svg = svgEl('svg', { class: 'nh-lines', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
  const nodesLayer = el('div', { class: 'nh-nodes' });
  const ledger = el('div', { class: 'nh-ledger' });
  const list = el('div', { class: 'nh-events', role: 'list', 'aria-label': 'Latest entries in the shared log. Demo data.' });
  ledger.append(
    el('div', { class: 'nh-ledger-head' }, [
      el('img', { src: '/ds/logos/logmem-symbol.svg', alt: '', width: '28', height: '20' }),
      el('div', {}, [el('strong', {}, ['Your LogMem space']), el('span', {}, ['Shared log · append-only'])]),
    ]),
    list,
  );
  const pauseBtn = el('button', { type: 'button', class: 'nh-pause', 'aria-pressed': 'false' }, ['Pause']);
  ledger.append(el('div', { class: 'nh-ledger-foot' }, [el('span', { class: 'lm-demo' }, ['Demo data']), el('span', { class: 'nh-slots' }, ['Who · Now · Log']), pauseBtn]));
  const summary = el('p', { class: 'lm-sr' }, ['Diagram with demo data. ChatGPT, Claude, Gemini, Cursor and Codex each write entries to one shared log. Before Claude sends anything irreversible, it asks a person, and the answer is written to the same log.']);
  root.append(summary, svg, nodesLayer, ledger);
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Agents writing to one shared log (demo)');

  const nodeEls = {};
  for (const [id, n] of Object.entries(NODES)) {
    const card = el('div', { class: 'nh-node', 'data-id': id, 'data-side': n.side, 'data-state': 'idle', 'data-human': n.human ? 'true' : 'false' }, [
      n.logo ? el('img', { src: n.logo, alt: '', width: '28', height: '28', loading: 'lazy' }) : el('span', { class: 'nh-you', 'aria-hidden': 'true' }, ['You']),
      el('div', { class: 'nh-node-text' }, [el('strong', {}, [n.name]), el('span', { class: 'nh-role' }, [n.role]), el('span', { class: 'nh-wait' }, ['Waiting on you'])]),
    ]);
    nodeEls[id] = card;
    nodesLayer.append(card);
  }

  const lineEls = {};
  function drawLayout() {
    const L = LAYOUTS[layout];
    root.dataset.layout = layout;
    root.style.setProperty('--ar', `${L.w} / ${L.h}`);
    svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
    svg.replaceChildren();
    for (const id of Object.keys(NODES)) {
      const p = svgEl('path', { d: pathFor(layout, id), class: 'nh-line', 'data-id': id, fill: 'none' });
      svg.append(p);
      lineEls[id] = p;
    }
    const pct = (v, total) => (v / total * 100).toFixed(3) + '%';
    for (const [id, card] of Object.entries(nodeEls)) {
      const [x, y] = L.pos[id];
      card.style.setProperty('--x', pct(x, L.w));
      card.style.setProperty('--y', pct(y, L.h));
      card.style.setProperty('--w', pct(L.node.w, L.w));
    }
    ledger.style.setProperty('--lx', pct(L.ledger.x, L.w));
    ledger.style.setProperty('--ly', pct(L.ledger.y, L.h));
    ledger.style.setProperty('--lw', pct(L.ledger.w, L.w));
    ledger.style.setProperty('--lh', pct(L.ledger.h, L.h));
  }
  drawLayout();
  phone.addEventListener('change', e => { layout = e.matches ? 'tall' : 'wide'; drawLayout(); a = null; });

  // ledger rows
  let entryN = 0;
  function addEntry(step, who, kind, text, animate) {
    const n = NODES[who];
    const row = el('div', { class: 'lm-event nh-event', role: 'listitem', 'data-k': step.k, 'data-new': animate ? 'true' : 'false' }, [
      el('time', { class: 'lm-event-time' }, [clock(entryN++)]),
      el('span', { class: 'lm-event-rule', 'aria-hidden': 'true' }),
      el('div', { class: 'lm-event-main' }, [
        el('div', { class: 'lm-event-line' }, [el('span', { class: 'lm-kind' }, [KIND_WORD[kind] || kind]), el('strong', { class: 'lm-title-3' }, [n.name.toLowerCase()])]),
        el('span', { class: 'lm-event-summary' }, [text]),
      ]),
    ]);
    list.prepend(row);
    const max = layout === 'tall' ? 3 : 5;
    while (list.children.length > max) list.lastElementChild.remove();
    return row;
  }

  // actions: each has a duration and an update(progress)
  const sleep = ms => ({ dur: ms });
  const setState = (id, state) => ({ dur: 1, start: () => { nodeEls[id].dataset.state = state; } });
  const entry = (step, who, kind, text) => ({ dur: 1, start: () => addEntry(step, who, kind, text, !finalOnly) });
  const pulse = (id, dir, tone) => {
    let dot, len, path;
    return {
      dur: 950,
      start: () => {
        path = lineEls[id]; len = path.getTotalLength();
        dot = svgEl('circle', { r: '5', class: 'nh-dot', 'data-tone': tone || 'teal' });
        svg.append(dot);
        path.dataset.hot = 'true';
      },
      update: p => {
        const e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const pt = path.getPointAtLength((dir === 'in' ? e : 1 - e) * len);
        dot.setAttribute('cx', pt.x.toFixed(1)); dot.setAttribute('cy', pt.y.toFixed(1));
      },
      end: () => { dot.remove(); path.dataset.hot = 'false'; },
    };
  };

  function actionsFor(step) {
    const a = [];
    if (step.ask) {
      a.push(setState(step.by, 'active'), pulse(step.by, 'in', 'amber'), entry(step, step.by, 'approval', step.text), setState(step.by, 'idle'), sleep(350));
      a.push(pulse('you', 'out', 'amber'), setState('you', 'waiting'), sleep(1900), setState('you', 'active'));
      a.push(pulse('you', 'in', 'teal'), entry({ k: 'decision' }, 'you', 'decided', 'Approved. Send issue 14'), setState('you', 'idle'), sleep(300));
      a.push(pulse(step.by, 'out', 'teal'), setState(step.by, 'active'), sleep(500));
      return a;
    }
    a.push(setState(step.by, 'active'), pulse(step.by, 'in'), entry(step, step.by, step.kind, step.text), setState(step.by, 'idle'));
    if (step.to) a.push(sleep(300), pulse(step.to, 'out'), setState(step.to, 'active'), sleep(550), setState(step.to, 'idle'));
    a.push(sleep(step.ask ? 0 : 750));
    return a;
  }
  // the Claude "done" step follows the approval, so its node is already active
  const script = STEPS.flatMap(actionsFor);

  let finalOnly = false, ai = 0, a = null, t = 0;
  function nextAction() {
    a = script[ai % script.length]; ai++; t = 0;
    a.start?.();
    if (ai % script.length === 1 && ai > 1) { /* loop: clear the log so the story reads from the top */ }
  }
  function step(dt) {
    if (!a) nextAction();
    t += dt;
    const p = Math.min(1, t / a.dur);
    a.update?.(p);
    if (p >= 1) { a.end?.(); a = null; }
  }

  function frame(now) {
    rafId = 0;
    if (!running) return;
    const dt = Math.min(64, now - (last || now));
    last = now;
    step(dt);
    rafId = requestAnimationFrame(frame);
  }
  function setRunning() {
    const should = !paused && visible && !document.hidden && !reduce.matches;
    if (should && !running) { running = true; last = 0; rafId = requestAnimationFrame(frame); }
    if (!should && running) { running = false; cancelAnimationFrame(rafId); }
  }

  // finished state for reduced motion: play the whole story instantly, once
  function drawStill() {
    finalOnly = true;
    root.querySelectorAll('.nh-dot').forEach(d => d.remove());
    for (let i = 0; i < script.length; i++) { const x = script[i]; x.start?.(); x.update?.(1); x.end?.(); }
    for (const c of Object.values(nodeEls)) c.dataset.state = 'idle';
    ai = 0; a = null;
    finalOnly = false;
  }

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Play' : 'Pause';
    pauseBtn.setAttribute('aria-pressed', String(paused));
    setRunning();
  });
  new IntersectionObserver(es => { visible = es[0].isIntersecting; setRunning(); }, { threshold: .2 }).observe(root);
  document.addEventListener('visibilitychange', setRunning);
  const motion = () => { pauseBtn.hidden = reduce.matches; if (reduce.matches) drawStill(); setRunning(); };
  reduce.addEventListener('change', motion);
  const seed = () => {
    entryN = 0;
    addEntry({ k: 'system' }, 'claude', 'started', 'Shift started. Brief read', false);
    addEntry({ k: 'handoff' }, 'codex', 'accepted', 'Accepted: review the newsletter template', false);
  };
  if (reduce.matches) { pauseBtn.hidden = true; seed(); drawStill(); } else seed();
  setRunning();
}

if (typeof document !== 'undefined') document.querySelectorAll('[data-network-hub]').forEach(mountNetworkHub);
