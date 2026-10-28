// flow-views.js — four small data views. Each is a lit-html template built from flow-model.js rows.
// Pass state in, get a template back. Pickers call redraw(), so the host page owns the render.
// Values reach the page only as text nodes or attribute values, never as HTML.
import { html, nothing, svg } from '/vendor/lit-html-3.2.1/lit-html.js';
import {agentDispatchButton} from './dispatch-components.js';
import {clusterPrompt} from './dispatch-model.js';
import { hhmm } from './core.js';
import { arcAgents, ringPoints, arcPath, replayEntries, replayBounds, replayAt, atFraction, pulseLanes, pulseAxis, blockerClusters, bubbleLayout, unblockPrompt } from './flow-model.js';

const pill = (label, on, click) => html`<button type="button" class="lmx-typepill" aria-pressed=${String(on)} @click=${click}>${label}</button>`;
const bandWord = { fresh: 'Under 3 days', slow: '3 to 7 days', stale: 'Over 7 days' };

/** Handoff map: each open handoff is an arc from sender to receiver. Colour shows how long it has waited. */
export function handoffMap({ arcs, sel = '', pick }) {
  if (!arcs.length) return nothing;
  const names = arcAgents(arcs), W = 600, H = 460, cx = 300, cy = 230, pts = ringPoints(names.length, cx, cy, 170), at = new Map(names.map((n, i) => [n, pts[i]]));
  const on = a => !sel || a.from === sel || a.to === sel;
  const rows = arcs.filter(on).slice(0, 4);
  return html`<section class="lmx-flow lmx-card" aria-label="Handoff map">
    <div class="lmx-flowhead"><h2>Handoff map</h2><span class="lmx-meta">${arcs.length} open ${arcs.length === 1 ? 'handoff' : 'handoffs'} from the queue. Each arc runs from sender to receiver.</span></div>
    <div class="lmx-flowsplit">
      <svg class="lmx-flowsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label=${`${arcs.length} open handoffs between ${names.length} agents. The oldest has waited ${arcs[0].label}.`}>
        <defs>${['fresh', 'slow', 'stale'].map(b => svg`<marker id=${'lmx-ar-' + b} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="lmx-ar" data-band=${b} d="M0 0 L10 5 L0 10 z"></path></marker>`)}</defs>
        <circle class="lmx-ring" cx=${cx} cy=${cy} r="170"></circle>
        ${arcs.map(a => svg`<path class="lmx-arc" data-band=${a.band} d=${arcPath(at.get(a.from), at.get(a.to), cx, cy, 0.35, 28)} marker-end=${`url(#lmx-ar-${a.band})`} opacity=${on(a) ? 1 : 0.12}></path>`)}
        ${names.map(n => { const p = at.get(n); return svg`<g class="lmx-node" data-on=${String(sel === n)}><circle cx=${p.x} cy=${p.y} r="24"></circle><text x=${p.x} y=${p.y + 5} class="lmx-nodeinit">${n.slice(0, 2)}</text><text x=${p.x} y=${p.y + 42} class="lmx-nodename">${n}</text></g>`; })}
      </svg>
      <div class="lmx-flowside">
        <div class="lm-eyebrow">Follow an agent</div>
        <div class="lmx-filter" role="group" aria-label="Follow an agent">${names.map(n => pill(n, sel === n, () => pick(sel === n ? '' : n)))}</div>
        <div class="lm-eyebrow">Waiting longest</div>
        ${rows.map(a => html`<div class="lmx-flowrow"><div><b class="mono">${a.from} → ${a.to}</b><span class="lmx-flowage" data-band=${a.band}>${a.label}</span></div><p>${a.summary}</p></div>`)}
        <ul class="lmx-flowkey">${Object.entries(bandWord).map(([b, w]) => html`<li><i data-band=${b}></i>${w}</li>`)}</ul>
      </div>
    </div></section>`;
}

/** Time scrubber: drag to see the log as it stood at a moment. Read only. */
export function timeScrubber({ entries, t = null, scrub, now = Date.now() }) {
  const rows = replayEntries(entries, now), bounds = replayBounds(rows);
  if (!bounds || bounds.start === bounds.end) return nothing;
  const at = t == null ? bounds.end : Math.min(Math.max(t, bounds.start), bounds.end), snap = replayAt(rows, at), live = at >= bounds.end;
  const frac = (at - bounds.start) / (bounds.end - bounds.start);
  const COUNTS = [['handoff', 'Handoffs'], ['approval', 'Asks'], ['stuck', 'Stuck'], ['done', 'Done'], ['progress', 'Progress']];
  return html`<section class="lmx-flow lmx-card" aria-label="Time scrubber">
    <div class="lmx-flowhead"><div><h2>Time scrubber</h2><span class="lmx-meta">Drag to see this window of the log as it stood then. Only the ${rows.length} entries loaded here are used.</span></div>
      <div class="lmx-scrubclock"><b class="mono">${hhmm(at)}</b><span class="lmx-flowage" data-band=${live ? 'fresh' : 'slow'}>${live ? 'Latest' : 'Replay'}</span></div></div>
    <div class="lmx-scrubstats">${COUNTS.map(([k, l]) => html`<div><span>${l}</span><b class="mono">${snap.counts[k]}</b></div>`)}</div>
    <input class="lmx-scrub" type="range" min="0" max="1000" step="5" .value=${String(Math.round(frac * 1000))} aria-label="Moment in this window" aria-valuetext=${hhmm(at)} @input=${e => scrub(atFraction(bounds, Number(e.target.value) / 1000))}>
    <div class="lmx-scrubends mono"><span>${hhmm(bounds.start)}</span><span>${hhmm(bounds.end)}</span></div>
    <div class="lm-eyebrow">Last five entries at this moment</div>
    ${snap.last.length ? snap.last.map(e => html`<div class="lmx-scrubrow"><span class="mono">${hhmm(e.ts)}</span><span class="lm-kind">${e.kind}</span><span class="mono">${String(e.by || '').replace(/^agent:/, '')}</span><span>${e.summary}</span></div>`) : html`<p class="lmx-meta">Nothing was written before this moment.</p>`}
  </section>`;
}

/** Fleet pulse: one lane per agent. Bars are runs of writing, diamonds are recaps, dashes are long silences. */
export function fleetPulse({ entries, agents = [], win = 24, sel = '', setWin, pick, now = Date.now() }) {
  const lanes = pulseLanes(entries, win, now, agents);
  if (!lanes.length) return nothing;
  return html`<section class="lmx-flow lmx-card" aria-label="Fleet pulse">
    <div class="lmx-flowhead"><div><h2>Fleet pulse</h2><span class="lmx-meta">One lane per agent. This shows reporting activity, not whether a process is running.</span></div>
      <div class="lmx-filter" role="group" aria-label="Pulse window">${[24, 6].map(h => pill(`Last ${h} h`, win === h, () => setWin(h)))}</div></div>
    <div class="lmx-lanes">${lanes.map(l => html`<div class="lmx-lane" data-dim=${String(!!sel && sel !== l.id)}>
      <button type="button" class="lmx-lanename mono" aria-pressed=${String(sel === l.id)} @click=${() => pick(sel === l.id ? '' : l.id)}>${l.id}</button>
      <div class="lmx-lanetrack">${l.quiet.map(q => html`<span class="lmx-quiet" style=${`left:${q.left}%;width:${q.width}%`}>${q.width > 22 ? `quiet ${q.hours} h` : ''}</span>`)}${l.bars.map(b => html`<i class="lmx-bar" style=${`left:${b.left}%;width:${b.width}%`}></i>`)}${l.recaps.map(r => html`<i class="lmx-recap" style=${`left:calc(${r}% - 6px)`}></i>`)}</div>
      <span class="lmx-lanestate" data-live=${String(l.live)}>${l.state}</span></div>`)}</div>
    <div class="lmx-laneaxis mono">${pulseAxis(win).map(a => html`<span>${a}</span>`)}</div>
    <ul class="lmx-flowkey"><li><i data-k="bar"></i>Writing</li><li><i data-k="recap"></i>Recap</li><li><i data-k="quiet"></i>Quiet ${6} hours or more</li></ul>
  </section>`;
}

/** Blocker map: jobs that wait on the same text share a bubble. Copy puts a prompt on the clipboard and starts nothing. */
export function blockerMap({ jobs, space, sel = '', pick, copy }) {
  const clusters = blockerClusters(jobs);
  if (!clusters.length) return nothing;
  const W = 600, H = 420, lay = bubbleLayout(clusters, W, H), cur = lay.find(c => c.key === sel) || lay[0], you = { x: 520, y: 100 }, agent = { x: 520, y: 320 };
  const end = c => (c.who === 'person' ? you : agent);
  return html`<section class="lmx-flow lmx-card" aria-label="Blocker map">
    <div class="lmx-flowhead"><h2>Blocker map</h2><span class="lmx-meta">${clusters.reduce((n, c) => n + c.jobs.length, 0)} blocked jobs in ${clusters.length} ${clusters.length === 1 ? 'group' : 'groups'}. Bigger bubble, more jobs stalled.</span></div>
    <div class="lmx-flowsplit">
      <svg class="lmx-flowsvg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Blocker groups">
        ${lay.map(c => svg`<path class="lmx-arc" data-band=${c.who === 'person' ? 'slow' : 'fresh'} d=${arcPath(c, end(c), 300, 210, 0.25)} opacity=${c.key === cur.key ? 1 : 0.18}></path>`)}
        <g class="lmx-node"><circle cx=${you.x} cy=${you.y} r="26"></circle><text class="lmx-nodeinit" x=${you.x} y=${you.y + 5}>you</text><text class="lmx-nodename" x=${you.x} y=${you.y + 44}>a person</text></g>
        <g class="lmx-node"><circle cx=${agent.x} cy=${agent.y} r="26"></circle><text class="lmx-nodeinit" x=${agent.x} y=${agent.y + 5}>ag</text><text class="lmx-nodename" x=${agent.x} y=${agent.y + 44}>another agent</text></g>
        ${lay.map(c => svg`<g class="lmx-bubble" role="button" tabindex="0" data-who=${c.who} data-on=${String(c.key === cur.key)} aria-label=${`${c.jobs.length} ${c.jobs.length === 1 ? 'job' : 'jobs'}: ${c.note}`} @click=${() => pick(c.key)} @keydown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(c.key); } }}><circle cx=${c.x} cy=${c.y} r=${c.radius}></circle><text class="lmx-bubblen" x=${c.x} y=${c.y + 6}>${c.jobs.length}</text></g>`)}
      </svg>
      <div class="lmx-flowside">
        <div class="lm-eyebrow">Selected</div>
        <h3 class="lmx-flowtitle">${cur.note}</h3>
        <p class="lmx-meta">${cur.who === 'person' ? 'Waits for a person.' : 'Waits for an agent or an outside step.'}</p>
        <div class="lmx-flowjobs">${cur.jobs.slice(0, 5).map(j => html`<a class="mono" href=${'#/job/' + encodeURIComponent(j.id)}>${j.id}</a>`)}${cur.jobs.length > 5 ? html`<span class="lmx-meta">+ ${cur.jobs.length - 5} more</span>` : nothing}</div>
        <pre class="lmx-flowprompt">${unblockPrompt(cur, space)}</pre>
        ${agentDispatchButton(clusterPrompt(cur,space),'Copy unblock prompt ('+cur.jobs.length+')')}
        <p class="lmx-meta">Copy only puts the text on your clipboard. It does not start anything.</p>
      </div>
    </div></section>`;
}
