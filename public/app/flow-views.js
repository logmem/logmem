// flow-views.js — four small data views. Each is a lit-html template built from flow-model.js rows.
// Pass state in, get a template back. Pickers call redraw(), so the host page owns the render.
// Values reach the page only as text nodes or attribute values, never as HTML.
import { html, nothing, svg } from '/vendor/lit-html-3.2.1/lit-html.js';
import {agentDispatchButton} from './dispatch-components.js';
import {clusterPrompt} from './dispatch-model.js';
import { hhmm, state } from './core.js';
import { agentIcon } from './agent-icons.js';
import { LOBEHUB_ICONS } from './lobehub-icons.js';
import { autoScrollOn } from './marquee.js';
import { arcAgents, ringPoints, arcPath, replayEntries, replayBounds, replayAt, replayDensity, atFraction, pulseLanes, pulseAxis, blockerClusters, bubbleLayout, unblockPrompt, involves, waitingOn, handoffMatrix, laneCounts, laneView, kindCounts, KIND_LABEL } from './flow-model.js';

const lobeBySlug = new Map(LOBEHUB_ICONS.map(i => [i.slug, i]));
const LOBE_FALLBACK_ALIASES = {
  hermes: 'hermesagent',
  'grok-local': 'grok',
  atlas: 'atlascloud',
  relay: 'relace',
  quill: 'lobehub',
  tally: 'tavily',
  polar: 'pollinations',
  mikey: 'openhuman',
  admin: 'openhuman',
};
const LOBE_POOL = ['anthropic', 'openai', 'gemini', 'grok', 'deepseek', 'mistral', 'perplexity', 'cohere', 'cursor', 'vercel'];
function lobeIconFor(name) {
  const bare = String(name || '').replace(/^(agent|human|person):/i, '').toLowerCase().trim();
  const direct = agentIcon(state.space, bare);
  if (direct) return direct;
  const alias = LOBE_FALLBACK_ALIASES[bare];
  if (alias && lobeBySlug.has(alias)) return lobeBySlug.get(alias);
  let h = 0;
  for (let i = 0; i < bare.length; i++) h = (h * 31 + bare.charCodeAt(i)) >>> 0;
  return lobeBySlug.get(LOBE_POOL[h % LOBE_POOL.length]) || null;
}

// Persistent lightweight pan/zoom/drag state per active handoff map session
const graphUI = { zoom: 1, offsets: new Map(), filter: 'all' };

function directedEdgeGeometry(p1, p2, cx, cy, hasReverse, pad = 29) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const sx = p1.x + ux * pad;
  const sy = p1.y + uy * pad;
  const ex = p2.x - ux * pad;
  const ey = p2.y - uy * pad;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  let qx, qy;
  if (hasReverse) {
    // Left-hand normal separates A->B and B->A symmetrically onto opposite arcs
    const bend = Math.min(46, Math.max(26, dist * 0.22));
    qx = mx - uy * bend;
    qy = my + ux * bend;
  } else {
    qx = mx + (cx - mx) * 0.24;
    qy = my + (cy - my) * 0.24;
  }
  return {
    d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
    lx: Math.round((sx + 2 * qx + ex) / 4),
    ly: Math.round((sy + 2 * qy + ey) / 4),
  };
}

function exportSvgElement(btn) {
  const svgEl = btn?.closest?.('.lmx-kg-wrap')?.querySelector('svg.lmx-kg-svg');
  if (!svgEl) return;
  const clone = svgEl.cloneNode(true);
  const data = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'logmem-handoff-network.svg';
  a.click();
  URL.revokeObjectURL(url);
}

const pill = (label, on, click, enter, leave) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(on)} @click=${click} @mouseenter=${enter} @mouseleave=${leave} @focus=${enter} @blur=${leave}>${label}</button>`;
const bandWord = { fresh: 'Under 1 day', slow: '1 to 7 days', stale: 'Over 7 days' };

/** Waiting strip: one compact card per open handoff, oldest first. It scrolls on its own and stops on hover or focus.
 *  A card filters the list below to that sender and receiver. Details opens the full text in a popover. */
function waitingStrip({ arcs, pair, pickPair }) {
  const toggle = e => {
    const b = e.currentTarget, strip = b.closest('.lmx-marquee-wrap').querySelector('.lmx-marquee'), on = strip.dataset.paused !== 'true';
    strip.dataset.paused = String(on);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Resume scrolling' : 'Pause scrolling';
  };
  return html`<div class="lmx-marquee-wrap">
    <div class="lmx-marqueehead"><div class="lm-eyebrow">Waiting longest, oldest first (${arcs.length})</div><button type="button" class="lmx-typepill lmx-marquee-toggle" aria-pressed="false" @click=${toggle}>Pause scrolling</button></div>
    <ul class="lmx-marquee" aria-label="Waiting handoffs, oldest first" ${autoScrollOn()}>${arcs.map((a, i) => { const on = !!pair && pair.from === a.from && pair.to === a.to, id = 'lmx-wp-' + i;
      return html`<li class="lmx-wcard" data-band=${a.band}>
        <button type="button" class="lmx-wmain" aria-pressed=${String(on)} title=${a.summary} @click=${() => pickPair && pickPair(on ? null : { from: a.from, to: a.to })}>
          <span class="lmx-wtop"><span class="lmx-wchip mono">${a.from}</span><span aria-hidden="true">→</span><span class="lmx-wchip mono">${a.to}</span><span class="lmx-flowage" data-band=${a.band}>${a.label}</span></span>
          <span class="lmx-wsum">${a.summary || 'No summary'}</span></button>
        <button type="button" class="lmx-wdetails" popovertarget=${id} aria-label=${`Details: ${a.from} to ${a.to}, waiting ${a.label}`}>Details ▾</button>
        <div popover id=${id} class="lmx-wpop"><b class="mono">${a.from} → ${a.to}</b> <span class="lmx-flowage" data-band=${a.band}>${a.label}</span><p>${a.summary || 'No summary'}</p><p class="lmx-meta mono">${a.trail}</p></div></li>`; })}</ul></div>`;
}

/** Handoff map: Network Map (Knowledge Graph with LobeHub icons, zoom, drag, SVG export)
 *  and Matrix Grid (Heat Map XL with LobeHub headers, sequential legend, stats & metrics). */
export function handoffMap({ arcs, sel = '', hover = '', pair = null, view = 'map', setView, pick, peek, pickPair }) {
  if (!arcs.length) return nothing;
  const names = arcAgents(arcs), waits = waitingOn(arcs), focus = hover || sel;
  const enter = n => () => peek && peek(n), leave = () => peek && peek('');
  const grid = view === 'matrix' && !!pickPair;
  const head = html`<div class="lmx-flowhead"><div><h2>Handoff map</h2><span class="lmx-meta">${arcs.length} open ${arcs.length === 1 ? 'handoff' : 'handoffs'} across ${names.length} agents. Click any node or cell to filter.</span></div>
    ${setView ? html`<div class="lmx-filter" role="group" aria-label="Handoff view">${pill('Network map', !grid, () => setView('map'))}${pill('Matrix grid', grid, () => setView('matrix'))}</div>` : nothing}</div>`;
  const key = html`<ul class="lmx-flowkey">${Object.entries(bandWord).map(([b, w]) => html`<li><i data-band=${b}></i>${w}</li>`)}</ul>`;
  const strip = waitingStrip({ arcs: arcs.filter(a => involves(a, sel)), pair, pickPair });

  // ── Matrix Grid (21st.dev Heat Map XL + LobeHub UI icons) ──
  if (grid) {
    const filteredArcs = graphUI.filter === 'late' ? arcs.filter(a => a.band !== 'fresh') : arcs;
    const { cells } = handoffMatrix(filteredArcs);
    const maxCount = Math.max(1, ...[...cells.values()].map(c => c.count));
    const lateCount = arcs.filter(a => a.band !== 'fresh').length;
    const latePct = arcs.length ? Math.round((lateCount / arcs.length) * 100) : 0;
    const busiest = [...cells.values()].sort((a, b) => b.count - a.count || b.age - a.age)[0] || null;
    const oldest = arcs[0] || null;

    const heatLevel = (c) => {
      if (!c) return 0;
      if (c.band === 'stale') return 3;
      if (c.band === 'slow') return 2;
      return Math.min(3, Math.max(1, Math.ceil((c.count / maxCount) * 2)));
    };

    return html`<section class="lmx-flow lmx-hm-card" aria-label="Handoff map">${head}${strip}
      <div class="lmx-hm-shell">
        <div class="lmx-hm-head">
          <div>
            <h3>Handoff Matrix</h3>
            <p class="lmx-meta">Rows send, columns receive. Select a cell to filter the queue.</p>
          </div>
          <select class="lm-select lmx-hm-select" aria-label="Filter matrix urgency" .value=${graphUI.filter} @change=${e => { graphUI.filter = e.target.value; setView('matrix'); }}>
            <option value="all">All open (${arcs.length})</option>
            <option value="late">Over 24h (${lateCount})</option>
          </select>
        </div>

        <div class="lmx-hm-body">
          <div class="lmx-hm-gridwrap">
            <table class="lmx-hm-table">
              <caption class="sr-only">Open handoffs by sender and receiver</caption>
              <thead>
                <tr>
                  <th scope="col" class="lmx-hm-corner">From \ To</th>
                  ${names.map(n => {
                    const ic = lobeIconFor(n);
                    return html`<th scope="col" class="lmx-hm-colhead" title=${n}>
                      <span class="lmx-hm-agent">${ic ? html`<img src=${ic.src} alt="" class="lmx-lobe-sm">` : nothing}<span>${n}</span></span>
                    </th>`;
                  })}
                </tr>
              </thead>
              <tbody>
                ${names.map(r => {
                  const ric = lobeIconFor(r);
                  return html`<tr>
                    <th scope="row" class="lmx-hm-rowhead" title=${r}>
                      <span class="lmx-hm-agent">${ric ? html`<img src=${ric.src} alt="" class="lmx-lobe-sm">` : nothing}<span>${r}</span></span>
                    </th>
                    ${names.map(c => {
                      const x = cells.get(r + '>' + c);
                      const on = !!pair && pair.from === r && pair.to === c;
                      const lvl = heatLevel(x);
                      return x
                        ? html`<td><button type="button" class="lmx-hm-cell" data-level=${lvl} data-band=${x.band} aria-pressed=${String(on)} title=${`${r} → ${c}: ${x.count} open · oldest ${x.label}`} aria-label=${`${r} to ${c}: ${x.count} open, oldest ${x.label}`} @click=${() => pickPair(on ? null : { from: r, to: c })}><strong>${x.count}</strong><span>${x.label}</span></button></td>`
                        : html`<td><span class="lmx-hm-empty" aria-hidden="true">${r === c ? '·' : ''}</span></td>`;
                    })}
                  </tr>`;
                })}
              </tbody>
            </table>
          </div>

          <aside class="lmx-hm-legend" aria-label="Heat intensity scale">
            <span class="lmx-hm-legval">${maxCount}</span>
            <span class="lmx-hm-legbar" aria-hidden="true"></span>
            <span class="lmx-hm-legval">0</span>
          </aside>
        </div>

        <div class="lmx-hm-stats">
          <div class="lmx-hm-stat">
            <span class="lmx-hm-statlabel">Delayed Handoffs</span>
            <div class="lmx-hm-statrow">
              <strong class="lmx-hm-statnum">${lateCount}</strong>
              <span class="lmx-hm-trend" data-tone=${lateCount > 0 ? 'danger' : 'success'}>
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">${lateCount > 0
                  ? svg`<path d="M5.5 9.1 10 4.7l4.5 4.4M10 4.7v11.6" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>`
                  : svg`<path d="M14.5 11.9 10 16.3l-4.5-4.4M10 16.3V4.7" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>`}</svg>
                ${latePct}%
              </span>
            </div>
            <span class="lmx-meta">Open longer than 24 hours</span>
          </div>
          <div class="lmx-hm-stat">
            <span class="lmx-hm-statlabel">Total Open Handoffs</span>
            <div class="lmx-hm-statrow">
              <strong class="lmx-hm-statnum">${arcs.length}</strong>
              <span class="lmx-hm-trend" data-tone="brand">${names.length} agents</span>
            </div>
            <span class="lmx-meta">Active across ${cells.size} sender→receiver pairs</span>
          </div>
        </div>

        <div class="lmx-hm-metrics">
          <div class="lmx-hm-metric">
            <span class="lmx-hm-mlabel"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6"/><path d="M10 6v4.3l2.6 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Oldest Unanswered Wait</span>
            <span class="lmx-hm-mval"><strong>${oldest ? oldest.label : '0 h'}</strong><span class="lmx-hm-mdot" data-tone=${oldest && oldest.band !== 'fresh' ? 'danger' : 'brand'}></span></span>
          </div>
          <div class="lmx-hm-metric">
            <span class="lmx-hm-mlabel"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Busiest Route</span>
            <span class="lmx-hm-mval"><strong>${busiest ? `${busiest.from} → ${busiest.to}` : 'None'}</strong>${busiest ? html`<span class="lmx-cockpit-badge" data-tone=${busiest.band === 'fresh' ? 'brand' : 'danger'}>${busiest.count}</span>` : nothing}</span>
          </div>
          <div class="lmx-hm-metric">
            <span class="lmx-hm-mlabel"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3 17.5 16H2.5L10 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="13.8" r=".8" fill="currentColor"/></svg>Active Agent Pairs</span>
            <span class="lmx-hm-mval"><strong>${cells.size}</strong><span class="lmx-hm-mdot" data-tone="brand"></span></span>
          </div>
        </div>
      </div>
    </section>`;
  }

  // ── Network Map (21st.dev Knowledge Graph + LobeHub UI icons) ──
  const W = 640, H = 430, cx = 320, cy = 215, R = 152;
  const pts = ringPoints(names.length, cx, cy, R);
  const at = new Map(names.map((n, i) => {
    const off = graphUI.offsets.get(n) || { dx: 0, dy: 0 };
    return [n, { x: pts[i].x + off.dx, y: pts[i].y + off.dy }];
  }));
  const { cells: pairMap } = handoffMatrix(arcs);
  const groupedEdges = [...pairMap.values()];
  const on = a => involves(a, focus);
  const near = n => !focus || n === focus || arcs.some(a => (a.from === focus && a.to === n) || (a.to === focus && a.from === n));
  const hoveredWait = hover ? waits.get(hover) : null;
  const hoveredPos = hover ? at.get(hover) : null;

  const startDrag = (name) => (ev) => {
    if (ev.button !== 0) return;
    const svgEl = ev.currentTarget.closest('svg');
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const startX = ev.clientX, startY = ev.clientY;
    const orig = graphUI.offsets.get(name) || { dx: 0, dy: 0 };
    let moved = false;
    const onMove = (m) => {
      const scaleX = W / Math.max(rect.width, 1) / graphUI.zoom;
      const scaleY = H / Math.max(rect.height, 1) / graphUI.zoom;
      const dx = (m.clientX - startX) * scaleX;
      const dy = (m.clientY - startY) * scaleY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      if (moved) {
        graphUI.offsets.set(name, { dx: orig.dx + dx, dy: orig.dy + dy });
        setView && setView('map');
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return html`<section class="lmx-flow lmx-card" aria-label="Handoff map">${head}${strip}
    <div class="lmx-kg-wrap">
      <div class="lmx-kg-toolbar" role="toolbar" aria-label="Network graph controls">
        <button type="button" class="lmx-di-microbtn" aria-label="Zoom in" @click=${() => { graphUI.zoom = Math.min(2, +(graphUI.zoom + 0.2).toFixed(2)); setView && setView('map'); }}>+</button>
        <button type="button" class="lmx-di-microbtn" aria-label="Zoom out" @click=${() => { graphUI.zoom = Math.max(0.6, +(graphUI.zoom - 0.2).toFixed(2)); setView && setView('map'); }}>−</button>
        <button type="button" class="lmx-di-microbtn" @click=${() => { graphUI.zoom = 1; graphUI.offsets.clear(); setView && setView('map'); }}>Reset</button>
        <button type="button" class="lmx-di-microbtn" @click=${e => exportSvgElement(e.currentTarget)}>Export SVG</button>
      </div>

      <div class="lmx-kg-canvas">
        <svg class="lmx-kg-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label=${`${arcs.length} open handoffs between ${names.length} agents. The oldest has waited ${arcs[0].label}.`}>
          <defs>
            ${['fresh', 'slow', 'stale'].map(b => svg`<marker id=${'lmx-ar-' + b} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path class="lmx-ar" data-band=${b} d="M0 0 L10 5 L0 10 z"></path></marker>`)}
            ${names.map((n, i) => {
              const p = at.get(n);
              return svg`<clipPath id=${'lmx-kg-clip-' + i}><circle cx=${p.x} cy=${p.y} r="17"></circle></clipPath>`;
            })}
          </defs>

          <g transform=${`translate(${cx} ${cy}) scale(${graphUI.zoom}) translate(${-cx} ${-cy})`}>
            <circle class="lmx-kg-orbit" cx=${cx} cy=${cy} r=${R}></circle>

            ${groupedEdges.map(edge => {
              const p1 = at.get(edge.from), p2 = at.get(edge.to);
              if (!p1 || !p2) return nothing;
              const hasReverse = pairMap.has(edge.to + '>' + edge.from);
              const { d, lx, ly } = directedEdgeGeometry(p1, p2, cx, cy, hasReverse, 30);
              const lit = on(edge);
              return svg`<g class="lmx-kg-edge" opacity=${lit ? 1 : 0.18}>
                <path class="lmx-arc lmx-kg-link" data-band=${edge.band} d=${d} marker-end=${`url(#lmx-ar-${edge.band})`} stroke-width=${Math.min(4, 1.8 + edge.count * 0.5)}></path>
                <g class="lmx-kg-edgelabel" transform=${`translate(${lx} ${ly})`}>
                  <rect x="-24" y="-9" width="48" height="18" rx="9"></rect>
                  <text text-anchor="middle" dy=".34em">${edge.count} · ${edge.label}</text>
                </g>
              </g>`;
            })}

            ${names.map((n, i) => {
              const p = at.get(n), w = waits.get(n), ic = lobeIconFor(n);
              const tone = w && w.late > 0 ? 'danger' : w && w.count > 0 ? 'brand' : 'neutral';
              const labelY = p.y < cy - 30 ? p.y - 33 : p.y + 40;
              return svg`<g class="lmx-node lmx-kg-node" role="button" tabindex="0" data-tone=${tone} data-on=${String(sel === n)} data-dim=${String(!near(n))} aria-pressed=${String(sel === n)} aria-label=${`${n}: ${w ? w.count : 0} waiting on this agent${w && w.late ? `, ${w.late} over a day` : ''}`}
                @pointerdown=${startDrag(n)}
                @click=${() => pick(sel === n ? '' : n)}
                @keydown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(sel === n ? '' : n); } }}
                @mouseenter=${enter(n)} @mouseleave=${leave} @focus=${enter(n)} @blur=${leave}>
                <circle class="lmx-kg-ring" cx=${p.x} cy=${p.y} r="25"></circle>
                <circle class="lmx-kg-core" cx=${p.x} cy=${p.y} r="20"></circle>
                ${ic
                  ? svg`<image href=${ic.src} x=${p.x - 13} y=${p.y - 13} width="26" height="26" clip-path=${`url(#lmx-kg-clip-${i})`} preserveAspectRatio="xMidYMid meet"></image>`
                  : svg`<text x=${p.x} y=${p.y + 4} class="lmx-nodeinit">${n.slice(0, 2)}</text>`}
                <text x=${p.x} y=${labelY} class="lmx-kg-nodelabel">${n}</text>
                ${w ? svg`<g class="lmx-badge" data-late=${String(w.late > 0)}><circle cx=${p.x + 19} cy=${p.y - 19} r="10"></circle><text x=${p.x + 19} y=${p.y - 15} class="lmx-badgen">${w.count}</text></g>` : nothing}
              </g>`;
            })}
          </g>
        </svg>

        ${hover && hoveredPos ? html`<div class="lmx-kg-tooltip" role="status">
          <strong>${hover}</strong> · ${hoveredWait ? `${hoveredWait.count} waiting${hoveredWait.late ? ` (${hoveredWait.late} delayed)` : ''}` : 'sender only'} · click to filter
        </div>` : nothing}

        <aside class="lmx-kg-legend" aria-label="Network legend">
          <div class="lmx-kg-legtitle">Wait age</div>
          ${Object.entries(bandWord).map(([b, w]) => html`<div class="lmx-kg-legitem"><i data-band=${b}></i><span>${w}</span></div>`)}
        </aside>
      </div>

      <div class="lmx-kg-agents" role="group" aria-label="Follow an agent">
        ${names.map(n => {
          const ic = lobeIconFor(n);
          const count = (waits.get(n) || { count: 0 }).count;
          return html`<button type="button" class="lmx-typepill lmx-kg-agentpill" aria-pressed=${String(sel === n)} @click=${() => pick(sel === n ? '' : n)} @mouseenter=${enter(n)} @mouseleave=${leave}>
            ${ic ? html`<img src=${ic.src} alt="" class="lmx-lobe-sm">` : nothing}
            <span>${n}</span>
            <b class="lmx-pillcount">${count}</b>
          </button>`;
        })}
      </div>
    </div></section>`;
}

/** Time scrubber: drag to see the log as it stood at a moment. Read only. */
export function timeScrubber({ entries, t = null, scrub, now = Date.now() }) {
  const rows = replayEntries(entries, now), bounds = replayBounds(rows);
  if (!bounds || bounds.start === bounds.end) return nothing;
  const at = t == null ? bounds.end : Math.min(Math.max(t, bounds.start), bounds.end), snap = replayAt(rows, at), live = at >= bounds.end;
  const frac = (at - bounds.start) / (bounds.end - bounds.start);
  const density=replayDensity(rows), fullTime=value=>new Date(value).toLocaleString();
  const COUNTS = [['handoff', 'Handoffs'], ['approval', 'Asks'], ['stuck', 'Stuck'], ['done', 'Done'], ['progress', 'Progress']];
  return html`<section class="lmx-flow lmx-card" aria-label="Time scrubber">
    <div class="lmx-flowhead"><div><h2>Time scrubber</h2><span class="lmx-meta">${rows.length} loaded entries. Drag through this interval. Counts describe saved events, not running agents.</span></div></div>
    <div class="lmx-telemetry-bar"><div class="lmx-scrubclock"><time class="mono" title=${fullTime(at)}>${hhmm(at)}</time><button type="button" class="lmx-typepill" aria-label="Jump to latest loaded entry" @click=${()=>scrub(null)}>${live?'Latest loaded':'Replay · return to latest'}</button></div><div class="lmx-telemetry-pills" aria-label="Counts at selected time">${COUNTS.map(([key,label])=>html`<span data-kind=${key}>${label} <b class="mono">${snap.counts[key]}</b></span>`)}</div></div>
    <div class="lmx-density-track"><svg viewBox="0 0 480 72" preserveAspectRatio="none" role="img" aria-label=${`Activity density across ${density.bins.length} time bins. The busiest bin has ${density.max} loaded entries. Amber shows recorded stuck events.`}>${density.bins.map(bin=>{const height=bin.count?Math.max(2,bin.count/density.max*62):1,stuck=bin.stuck/density.max*62;return svg`<rect class="lmx-density-bar" x=${bin.index*10+1} y=${68-height} width="7" height=${height} opacity=${bin.count?0.35+0.65*bin.count/density.max:0.12}></rect>${bin.stuck?svg`<rect class="lmx-density-stuck" x=${bin.index*10+1} y=${68-height} width="7" height=${Math.max(3,stuck)}></rect>`:nothing}`;})}</svg><span class="lmx-density-needle" style=${'left:calc(10px + (100% - 20px) * '+frac+')'} aria-hidden="true"></span><input class="lmx-scrub lmx-density-input" type="range" min="0" max="1000" step="1" .value=${String(Math.round(frac*1000))} aria-label="Moment in this window" aria-valuetext=${fullTime(at)+' · '+snap.total+' loaded entries'} @input=${e=>scrub(atFraction(bounds,Number(e.target.value)/1000))}></div>
    <div class="lmx-scrubends mono"><time title=${fullTime(bounds.start)}>${fullTime(bounds.start)}</time><time title=${fullTime(bounds.end)}>${fullTime(bounds.end)}</time></div>
    <div class="lmx-spike-jumps" role="group" aria-label="Jump to activity spikes">${density.peaks.map(peak=>html`<button type="button" class="lmx-typepill" data-kind=${peak.key} title=${fullTime(peak.at)} @click=${()=>scrub(peak.at)}>${peak.key==='stuck'?'⚠':'↗'} ${peak.label} (${peak.count}) · ${hhmm(peak.at)}</button>`)}<span class="lmx-meta">Teal: entries · Amber: stuck. Peaks use ${density.bins.length} equal intervals.</span></div>
    <div class="lm-eyebrow">Last five entries at this moment</div>
    ${snap.last.length ? snap.last.map(e => html`<div class="lmx-scrubrow"><span class="mono">${hhmm(e.ts)}</span><span class="lm-kind">${e.kind}</span><span class="mono">${String(e.by || '').replace(/^agent:/, '')}</span><span>${e.summary}</span></div>`) : html`<p class="lmx-meta">Nothing was written before this moment.</p>`}
  </section>`;
}

/** Fleet pulse (21st.dev Heat Strip id: 29464 + Status Bar id: 26906):
 *  One compact heat-strip row per agent. Vertical bars scale in height & opacity with entry volume,
 *  green ticks mark recaps, muted blocks mark quiet stretches, and all quiet agents stay visible as inline chips. */
export function fleetPulse({ entries, agents = [], win = 24, sel = '', show = 'active', setShow, setWin, pick, now = Date.now() }) {
  const lanes = pulseLanes(entries, win, now, agents);
  if (!lanes.length) return nothing;
  const n = laneCounts(lanes), shown = laneView(lanes, show), tucked = show === 'active' ? lanes.filter(l => l.empty) : [];
  const BINS = 24;
  const spanMs = win * 3600e3;
  const startMs = now - spanMs;
  const binMs = spanMs / BINS;

  // Build exact per-agent 24-bucket counts from real entries (oldest left -> newest right).
  const byAgent = new Map();
  for (const l of lanes) {
    byAgent.set(l.id, Array.from({ length: BINS }, () => ({ count: 0, recap: false })));
  }
  let totalEntries = 0;
  for (const e of entries || []) {
    const ts = Number(e?.ts);
    if (!Number.isFinite(ts) || ts < startMs || ts > now) continue;
    const aid = String(e?.by || '').replace(/^agent:/, '');
    const arr = byAgent.get(aid);
    if (!arr) continue;
    const idx = Math.min(BINS - 1, Math.max(0, Math.floor((ts - startMs) / binMs)));
    arr[idx].count++;
    if (e.kind === 'recap') arr[idx].recap = true;
    totalEntries++;
  }
  let peakBin = 0;
  for (const arr of byAgent.values()) {
    for (const b of arr) if (b.count > peakBin) peakBin = b.count;
  }
  const safeMax = Math.max(peakBin, 1);

  const binLabel = (idx) => {
    const t0 = startMs + idx * binMs;
    const t1 = t0 + binMs;
    return `${hhmm(t0)}–${hhmm(t1)}`;
  };

  const row = l => {
    const bins = byAgent.get(l.id) || [];
    const agentTotal = bins.reduce((s, b) => s + b.count, 0);
    return html`<div class="lm-fp-row" data-dim=${String(!!sel && sel !== l.id)} data-selected=${String(sel === l.id)}>
      <button type="button" class="lm-fp-agent" aria-pressed=${String(sel === l.id)} @click=${() => pick(sel === l.id ? '' : l.id)}>
        <span class="lm-fp-dot" data-s=${l.status} aria-hidden="true"></span>
        <span class="lm-fp-name mono">${l.id}</span>
        <span class="lm-fp-total mono">${agentTotal}</span>
      </button>
      <div class="lm-fp-strip" role="img" aria-label=${`${l.id}: ${agentTotal} entries in the last ${win} hours`}>
        ${bins.map((b, i) => {
          const pct = b.count ? Math.max(18, Math.round((b.count / safeMax) * 100)) : 10;
          const op = b.count ? (0.32 + 0.68 * (b.count / safeMax)).toFixed(2) : '';
          return html`<span class=${'lm-fp-cell' + (b.count ? ' has-hit' : '') + (b.recap ? ' has-recap' : '')} title=${`${l.id} · ${binLabel(i)}: ${b.count} ${b.count === 1 ? 'entry' : 'entries'}${b.recap ? ' (recap)' : ''}`}>
            <i style=${`height:${pct}%;${op ? 'opacity:' + op : ''}`}></i>
          </span>`;
        })}
      </div>
      <span class="lm-fp-state" data-s=${l.status}>${l.state}</span>
    </div>`;
  };
  const views = [['active', 'Active', n.active], ['live', 'Live now', n.live], ['quiet', 'Quiet', n.quiet], ['all', 'All', n.all]];
  return html`<section class="lm-fp" aria-label="Fleet pulse">
    <div class="lm-fp-head">
      <div class="lm-fp-titleblock">
        <div class="lm-fp-toprow">
          <h2>Fleet pulse</h2>
          <div class="lm-fp-stats mono">
            <span>total <strong>${totalEntries}</strong></span>
            <span>peak <strong>${peakBin}</strong>/slot</span>
            <span>active <strong>${n.active}/${n.all}</strong></span>
          </div>
        </div>
        <span class="lmx-meta">Reporting activity across ${BINS} intervals · not runtime reachability.</span>
      </div>
      <div class="lm-fp-controls">
        ${setShow ? html`<div class="lm-fp-seg" role="group" aria-label="Show agents">${views.map(([k, label, c]) => html`<button type="button" aria-pressed=${String(show === k)} @click=${() => setShow(k)}>${label} <span>${c}</span></button>`)}</div>` : nothing}
        <div class="lm-fp-seg" role="group" aria-label="Pulse window">${[24, 6].map(h => html`<button type="button" aria-pressed=${String(win === h)} @click=${() => setWin(h)}>${h}h</button>`)}</div>
      </div>
    </div>
    <div class="lm-fp-body">
      ${shown.length ? shown.map(row) : html`<p class="lmx-meta" style="padding:14px 4px;margin:0">No agents match this view in the last ${win} h.</p>`}
    </div>
    ${shown.length ? html`<div class="lm-fp-axis mono"><span></span><div class="lm-fp-ticks">${pulseAxis(win).map(a => html`<span>${a}</span>`)}</div><span></span></div>` : nothing}
    ${tucked.length ? html`<div class="lm-fp-quietbar"><span class="lmx-meta">No entries in ${win}h (${tucked.length}):</span><div class="lm-fp-quietchips">${tucked.map(l => html`<button type="button" class="lm-fp-qchip mono" aria-pressed=${String(sel === l.id)} @click=${() => pick(sel === l.id ? '' : l.id)}>${l.id}</button>`)}</div></div>` : nothing}
    <div class="lm-fp-foot">
      <ul class="lm-fp-legend">
        <li><i class="is-low"></i>Low</li>
        <li><i class="is-mid"></i>Moderate</li>
        <li><i class="is-high"></i>Peak</li>
        <li><i class="is-recap"></i>Recap tick</li>
      </ul>
      <span class="lmx-meta">Click an agent to isolate its lane · hover any bar for exact counts.</span>
    </div>
  </section>`;
}

const KIND_GLYPH = { person: '!', vendor: '$', agent: 'A' };
const KIND_SHORT = { person: 'Waiting on a person', vendor: 'Billing & infrastructure', agent: 'Waiting on an agent' };

/** Blocker map: jobs that wait on the same text share a bubble. Colour shows who or what holds the lock.
 *  The kind pills dim the other bubbles. Copy puts a prompt on the clipboard and starts nothing. */
export function blockerMap({ jobs, space, sel = '', kind = '', setKind, pick, copy }) {
  const clusters = blockerClusters(jobs);
  if (!clusters.length) return nothing;
  const W = 600, H = 420, lay = bubbleLayout(clusters, W, H), match = c => !kind || c.kind === kind;
  const cur = lay.find(c => c.key === sel && match(c)) || lay.find(match) || lay[0], you = { x: 520, y: 100 }, agent = { x: 520, y: 320 };
  const end = c => (c.who === 'person' ? you : agent), counts = kindCounts(clusters);
  const pills = [['', 'All', counts.all], ['person', KIND_SHORT.person, counts.person], ['vendor', KIND_SHORT.vendor, counts.vendor], ['agent', KIND_SHORT.agent, counts.agent]];
  const prompt = clusterPrompt(cur, space);
  return html`<section class="lmx-flow lmx-card" aria-label="Blocker map">
    <div class="lmx-flowhead"><div><h2>Blocker map</h2><span class="lmx-meta">${counts.all} blocked jobs in ${clusters.length} ${clusters.length === 1 ? 'group' : 'groups'}. Bigger bubble, more jobs stalled. Colour shows who holds the lock. A pulsing ring means a job has waited over 3 days.</span></div></div>
    ${setKind ? html`<div class="lmx-filter" role="group" aria-label="Blocker kind">${pills.map(([k, label, c]) => pill(html`${label} <b class="lmx-pillcount">${c}</b>`, kind === k, () => setKind(k)))}</div>` : nothing}
    <div class="lmx-flowsplit">
      <svg class="lmx-flowsvg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Blocker groups">
        ${lay.map(c => svg`<path class="lmx-arc" data-who=${c.who} d=${arcPath(c, end(c), 300, 210, 0.25)} opacity=${c.key === cur.key ? 1 : match(c) ? 0.18 : 0.06}></path>`)}
        <g class="lmx-node"><circle cx=${you.x} cy=${you.y} r="26"></circle><text class="lmx-nodeinit" x=${you.x} y=${you.y + 5}>you</text><text class="lmx-nodename" x=${you.x} y=${you.y + 44}>a person</text></g>
        <g class="lmx-node"><circle cx=${agent.x} cy=${agent.y} r="26"></circle><text class="lmx-nodeinit" x=${agent.x} y=${agent.y + 5}>ag</text><text class="lmx-nodename" x=${agent.x} y=${agent.y + 44}>another agent</text></g>
        ${lay.map(c => svg`<g class="lmx-bubble" role="button" tabindex="0" data-who=${c.who} data-kind=${c.kind} data-late=${String(c.late)} data-dim=${String(!match(c))} data-on=${String(c.key === cur.key)} aria-label=${`${c.jobs.length} ${c.jobs.length === 1 ? 'job' : 'jobs'}, ${KIND_LABEL[c.kind]}${c.late ? ', waiting over 3 days' : ''}: ${c.note}`} @click=${() => pick(c.key)} @keydown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c.key); } }}><circle class="lmx-bubblering" cx=${c.x} cy=${c.y} r=${c.radius}></circle><circle cx=${c.x} cy=${c.y} r=${c.radius}></circle><text class="lmx-bubblen" x=${c.x} y=${c.y + 6}>${c.jobs.length}</text><g class="lmx-kindbadge"><circle cx=${c.x + c.radius * 0.72} cy=${c.y - c.radius * 0.72} r="9"></circle><text x=${c.x + c.radius * 0.72} y=${c.y - c.radius * 0.72 + 4}>${KIND_GLYPH[c.kind]}</text></g></g>`)}
      </svg>
      <div class="lmx-flowside">
        <div class="lm-eyebrow">Selected</div>
        <h3 class="lmx-flowtitle">${cur.note}</h3>
        <p class="lmx-meta"><span class="lmx-kindtag" data-kind=${cur.kind}>${KIND_LABEL[cur.kind]}</span> ${cur.who === 'person' ? 'Waits for a person.' : 'Waits for an agent or an outside step.'}</p>
        <div class="lmx-flowjobs">${cur.jobs.slice(0, 5).map(j => html`<a class="mono" href=${'#/job/' + encodeURIComponent(j.id)}>${j.id}</a>`)}${cur.jobs.length > 5 ? html`<span class="lmx-meta">+ ${cur.jobs.length - 5} more</span>` : nothing}</div>
        <details class="lmx-preview" open><summary>Preview what Copy will paste (${prompt.length} characters)</summary><pre class="lmx-flowprompt" data-kind=${cur.kind}>${prompt}</pre></details>
        ${agentDispatchButton(prompt,'Copy unblock prompt ('+cur.jobs.length+')')}
        <p class="lmx-meta">Copy only puts the text on your clipboard. It does not start anything.</p>
      </div>
    </div></section>`;
}
