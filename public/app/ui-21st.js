// ui-21st.js: Vanilla lit-html port of the tokenized 21st.dev dashboard components
// (AgentStatus, AgentTrace, ChronoBoard, ActivityTimeline, RelativeTime world clock,
//  Shift Gantt Timeline + DailyTimelineScheduler). Pure ES module, zero bundler, var(--*) only.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { agentName } from './core.js';
import { agent, idChip, textWithIds } from './ui.js';
import { relTime, fullTime, clock24, placeLink } from './brief-model.js';

const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

export function formatSpanMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function mapSpanKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'started' || k === 'recap' || k === 'joined') return 'agent';
  if (k === 'progress' || k === 'research' || k === 'checkup' || k === 'pivot') return 'model';
  if (k === 'assigned' || k === 'handoff' || k === 'accepted' || k === 'approval' || k === 'fix' || k === 'decided') return 'tool';
  return 'io';
}

function mapSpanStatus(kind) {
  const k = String(kind || '').toLowerCase();
  return k === 'stuck' || k === 'problem' || k === 'alert' ? 'error' : 'ok';
}

function kindTone(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'done' || k === 'accepted' || k === 'decided') return 'success';
  if (k === 'stuck' || k === 'problem' || k === 'alert') return 'danger';
  if (k === 'approval' || k === 'handoff') return 'warning';
  if (k === 'progress' || k === 'started' || k === 'research') return 'brand';
  return 'neutral';
}

/** Build real AgentTrace spans from an agent's shifts and log entries (never invents spans). */
export function buildVanillaAgentTrace(agentId, shifts = [], log = []) {
  const clean = (Array.isArray(log) ? log : [])
    .filter((e) => e && Number(e.ts) > 0)
    .slice(0, 40)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const latest = Array.isArray(shifts) && shifts.length ? shifts[0] : null;
  const shiftId = latest?.shift ? String(latest.shift) : null;
  const shiftRows = shiftId ? clean.filter((e) => e.shift === shiftId) : clean.slice(-14);
  const chosen = shiftRows.length ? shiftRows.slice(-16) : clean.slice(-14);
  if (!chosen.length) return { runId: shiftId || `agent:${agentId}`, model: latest?.surface || null, duration: 0, spans: [] };

  const originTs = Number(latest?.started_at || latest?.ts || chosen[0].ts);
  const lastTs = Math.max(Number(latest?.ended_at || chosen[chosen.length - 1].ts), Number(chosen[chosen.length - 1].ts), originTs + 1000);
  const total = Math.max(1000, Math.min(lastTs - originTs, 24 * 3_600_000));
  const minBar = Math.max(150, Math.round(total * 0.04));
  const rootId = shiftId || `run-${agentId}`;

  const spans = [{
    id: rootId,
    label: `shift.${agentId}`,
    kind: 'agent',
    status: 'ok',
    depth: 0,
    start: 0,
    end: total,
    dur: total,
    detail: `${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}`,
    summary: latest?.surface ? `Shift via ${latest.surface}` : 'Recorded activity window',
    trail: shiftId,
    ts: originTs,
    entryKind: 'started',
  }];

  for (let i = 0; i < chosen.length; i += 1) {
    const e = chosen[i], next = chosen[i + 1];
    const start = Math.max(0, Math.min(total - minBar, Number(e.ts) - originTs));
    const rawEnd = next ? Math.max(start + minBar, Number(next.ts) - originTs) : total;
    const end = Math.min(total, Math.max(start + minBar, rawEnd));
    const summary = String(e.summary || '').trim();
    const jobClean = e.job ? String(e.job).replace(/^(job|channel|agent):/, '') : '';
    spans.push({
      id: String(e.trail || `${rootId}-${i}`),
      label: jobClean ? `${e.kind || 'entry'} · ${jobClean}` : String(e.kind || 'entry'),
      kind: mapSpanKind(e.kind),
      status: mapSpanStatus(e.kind),
      depth: 1,
      start,
      end,
      dur: Math.max(1, end - start),
      detail: summary.length > 40 ? summary.slice(0, 37) + '…' : summary,
      summary,
      trail: e.trail ? String(e.trail) : null,
      ts: Number(e.ts),
      entryKind: String(e.kind || 'memo'),
    });
  }
  return { runId: shiftId || `agent:${agentId}`, model: latest?.surface || null, duration: total, spans };
}

/** 1. AgentStatus card (21st.dev id: 36497) — current task + real handoff/next task tray. */
export function agentStatusCard({ title, detail, badge, tasks = [] }) {
  const done = tasks.filter((t) => t.status === 'complete').length;
  const icon = (st) => st === 'complete' ? '✓' : st === 'running' ? '●' : '○';
  return html`<section class="lm-astatus" aria-label="Agent current status">
    <header class="lm-astatus-head">
      <span class="lm-astatus-ico" aria-hidden="true">☰</span>
      <div class="lm-astatus-main">
        <div class="lm-astatus-title-row"><h3>${title}</h3>${badge ? html`<span class="lm-astatus-badge">${badge}</span>` : nothing}</div>
        ${detail ? html`<p class="lm-astatus-detail">${detail}</p>` : nothing}
      </div>
      ${tasks.length ? html`<span class="lm-astatus-count">${done}/${tasks.length}</span>` : nothing}
    </header>
    ${tasks.length ? html`<ul class="lm-astatus-list">${tasks.map((t) => html`<li data-st=${t.status}><span class="lm-astatus-dot" aria-label=${t.status}>${icon(t.status)}</span><span class="lm-astatus-label">${t.label}</span>${t.meta ? html`<span class="lm-astatus-meta">${t.meta}</span>` : nothing}</li>`)}</ul>` : nothing}
  </section>`;
}

/** 2. AgentTrace card (21st.dev id: 26968) — interactive scrubbable waterfall replay. */
const traceTimers = new WeakMap();
export function agentTraceCard({ trace, pf, redraw, now = Date.now() }) {
  if (!trace || !trace.spans.length) return nothing;
  const total = Math.max(1, trace.duration);
  const tKey = 'traceT:' + trace.runId;
  const cur = pf[tKey] == null ? total : Math.max(0, Math.min(total, Number(pf[tKey])));
  const pct = (cur / total) * 100;
  const selected = trace.spans.find((s) => s.id === pf.traceSel) || null;
  const playing = !!pf.tracePlaying;

  const stopPlay = () => {
    if (traceTimers.has(pf)) {
      cancelAnimationFrame(traceTimers.get(pf));
      traceTimers.delete(pf);
    }
    pf.tracePlaying = false;
  };

  const togglePlay = () => {
    if (pf.tracePlaying) { stopPlay(); redraw(); return; }
    if (cur >= total) pf[tKey] = 0;
    pf.tracePlaying = true;
    let last = performance.now();
    const scale = total > 12_000 ? total / 5000 : 1;
    const step = (ts) => {
      if (!pf.tracePlaying) return;
      const dt = Math.min(ts - last, 100);
      last = ts;
      const next = (pf[tKey] ?? 0) + dt * scale;
      if (next >= total) {
        pf[tKey] = total;
        stopPlay();
        redraw();
        return;
      }
      pf[tKey] = next;
      redraw();
      traceTimers.set(pf, requestAnimationFrame(step));
    };
    redraw();
    traceTimers.set(pf, requestAnimationFrame(step));
  };

  const seek = (ms) => {
    stopPlay();
    pf[tKey] = Math.max(0, Math.min(total, ms));
    redraw();
  };

  const ticks = [0.25, 0.5, 0.75].map((f) => ({ left: `${f * 100}%`, label: formatSpanMs(total * f) }));

  return html`<section class="lm-trace" aria-label=${'Agent run trace ' + trace.runId}>
    <header class="lm-trace-head">
      <span class="lm-trace-dot" data-running=${String(playing || cur < total)} aria-hidden="true"></span>
      <span class="lm-trace-id">${trace.runId}</span>
      <span class="lm-trace-sub">${trace.model ? trace.model + ' · ' : ''}${trace.spans.length} spans</span>
      <span class="lm-trace-pill">${cur >= total ? 'Completed' : 'Replaying'}</span>
    </header>
    <div class="lm-trace-ruler" aria-hidden="true">
      <div class="lm-trace-trackbox">${ticks.map((tk) => html`<span style=${'left:' + tk.left}>${tk.label}</span>`)}</div>
    </div>
    <div class="lm-trace-body">
      <ol class="lm-trace-rows" aria-label=${'Spans in ' + trace.runId}>
        ${trace.spans.map((s) => {
          const p = s.dur > 0 ? Math.max(0, Math.min(1, (cur - s.start) / s.dur)) : cur >= s.start ? 1 : 0;
          const st = cur < s.start ? 'queued' : p < 1 ? 'running' : s.status === 'error' ? 'error' : 'done';
          const left = `${(s.start / total) * 100}%`;
          const width = `${Math.max(1, (s.dur / total) * 100)}%`;
          return html`<li class="lm-trace-row" data-state=${st} data-selected=${String(pf.traceSel === s.id)}>
            <button type="button" class="lm-trace-label" style=${'padding-left:' + (s.depth * 12 + 6) + 'px'} @click=${() => { pf.traceSel = s.id; seek(s.start); }}>
              <span class="lm-trace-kdot" data-kind=${s.kind} aria-hidden="true"></span>
              <span class="lm-trace-name">${s.label}</span>
            </button>
            <div class="lm-trace-barcol">
              <div class="lm-trace-barwrap" style=${`left:${left};width:${width}`}>
                <span class="lm-trace-barbg" aria-hidden="true"></span>
                <span class="lm-trace-barfill" data-kind=${s.kind} data-status=${s.status} style=${`transform:scaleX(${p.toFixed(4)})`} aria-hidden="true"></span>
              </div>
            </div>
            <div class="lm-trace-meta">
              <span class="lm-trace-detail">${st === 'queued' ? '' : (p >= 1 ? s.detail : '')}</span>
              <span class="lm-trace-dur">${st === 'queued' ? '' : formatSpanMs(s.dur * p)}</span>
            </div>
          </li>`;
        })}
      </ol>
      <div class="lm-trace-playhead-box" aria-hidden="true"><span class="lm-trace-playhead" style=${`left:${pct.toFixed(3)}%`}></span></div>
    </div>
    <footer class="lm-trace-transport">
      <button type="button" class="lm-trace-play" aria-label=${playing ? 'Pause replay' : 'Play replay'} @click=${togglePlay}>${playing ? '❚❚' : '▶'}</button>
      <input type="range" class="lm-trace-scrub" aria-label="Playhead" min="0" max=${Math.round(total)} .value=${String(Math.round(cur))} @input=${(e) => seek(Number(e.currentTarget.value))}>
      <span class="lm-trace-clock">${formatSpanMs(cur)} / ${formatSpanMs(total)}</span>
    </footer>
    ${selected ? html`<div class="lm-trace-inspect">
      <div class="lm-trace-inspect-head">
        <span class="lmx-kind-chip" data-k=${selected.entryKind || 'system'}>${selected.entryKind || selected.kind}</span>
        <strong class="mono">${selected.label}</strong>
        ${selected.ts ? html`<span class="lmx-meta">${relTime(selected.ts, now)}</span>` : nothing}
        ${selected.trail ? idChip(selected.trail, 'trail') : nothing}
      </div>
      ${selected.summary ? html`<p>${textWithIds(selected.summary)}</p>` : nothing}
    </div>` : nothing}
  </section>`;
}

/** 3. ChronoBoard — connected vertical timeline cards (Brief Recent updates). */
export function chronoBoard(list = [], now = Date.now()) {
  return html`<ol class="lm-chrono" aria-label="Recent chronological updates">
    ${list.map((e, i) => {
      const tone = kindTone(e.kind);
      const place = placeLink(e.where);
      return html`<li class="lm-chrono-item" data-active=${String(i === 0)}>
        <span class="lm-chrono-dot" data-tone=${tone} aria-hidden="true"></span>
        <div class="lm-chrono-card">
          <div class="lm-chrono-top">
            <p class="lm-chrono-title">${textWithIds(e.summary)}</p>
            <time class="lm-chrono-date" datetime=${Number.isFinite(Number(e.ts)) ? new Date(Number(e.ts)).toISOString() : nothing} title=${fullTime(e.ts)}>${relTime(e.ts, now)}</time>
          </div>
          <div class="lm-chrono-foot">
            <span class="lm-chrono-badge" data-tone=${tone}>${e.kind || 'update'}</span>
            <span class="lm-chrono-meta">${agentName(e.by) || 'unknown'}${place ? html` · <a href=${place.href}>${place.label}</a>` : nothing}</span>
          </div>
        </div>
      </li>`;
    })}
  </ol>`;
}

/** 4. Open-by-default ActivityTimeline rows (day-grouped, zero hidden details). */
export function activityTimelineGroup(group, { now = Date.now() } = {}) {
  return html`<section class="lm-actline-day" aria-label=${group.label}>
    <h2 class="lm-actline-head"><span>${group.label}</span><span class="lm-actline-count">${group.entries.length} ${group.entries.length === 1 ? 'update' : 'updates'}</span></h2>
    <ol class="lm-actline-list">
      ${group.entries.map((e) => {
        const tone = kindTone(e.kind);
        const place = placeLink(e.where);
        return html`<li class="lm-actline-item">
          <span class="lm-actline-dot" data-tone=${tone} aria-hidden="true"></span>
          <div class="lm-actline-body">
            <div class="lm-actline-trigger" style="cursor:default">
              <span class="lm-actline-text">
                <span class="lm-actline-line"><strong>${agentName(e.by) || 'unknown'}</strong> ${textWithIds(e.summary)}</span>
                <span class="lm-actline-detail-row" style="margin-top:4px">
                  <span class="lmx-kind-chip" data-k=${e.group || 'system'}>${e.kind}</span>
                  ${place ? html`<a href=${place.href}>${place.label}</a>` : html`<span class="lmx-meta">${e.where || 'No place recorded'}</span>`}
                  ${e.via ? html`<span class="lmx-meta">via ${e.via}</span>` : nothing}
                  ${e.trail ? idChip(e.trail, 'trail') : nothing}
                </span>
              </span>
              <time class="lm-actline-time" datetime=${new Date(Number(e.ts)).toISOString()} title=${fullTime(e.ts)}>${clock24(e.ts)} · ${relTime(e.ts, now)}</time>
            </div>
          </div>
        </li>`;
      })}
    </ol>
  </section>`;
}

/** 5. WorldClockStrip (RelativeTime) — ET / UTC / PT reference strip. */
export function worldClockStrip(now = Date.now()) {
  const zones = [
    ['ET', 'America/New_York'],
    ['UTC', 'UTC'],
    ['PT', 'America/Los_Angeles'],
  ];
  const d = new Date(now);
  const fmt = (tz) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
  return html`<div class="lm-wclock" aria-label="Reference time zones">
    ${zones.map(([label, tz]) => html`<div class="lm-wclock-zone"><span class="lm-wclock-lbl">${label}</span><span class="lm-wclock-val">${fmt(tz)}</span></div>`)}
  </div>`;
}

/** 6. Shift Gantt Timeline + DailyTimelineScheduler (for #/slots). */
export function shiftTimelineSection({ agents = [], pf, redraw, now = Date.now() }) {
  const shifts = (Array.isArray(agents) ? agents : [])
    .filter((a) => a && (a.shift?.ts || a.last?.ts))
    .map((a) => {
      const startTs = Number(a.shift?.ts || a.last?.ts);
      const endTs = Math.max(Number(a.last?.ts || startTs), startTs);
      const dt = new Date(startTs);
      const startH = dt.getUTCHours(), startM = dt.getUTCMinutes();
      const rawMins = Math.round((Math.min(endTs, now) - startTs) / 60_000);
      const duration = Math.max(35, Math.min(300, rawMins > 0 ? rawMins : 50));
      return {
        id: String(a.shift?.shift || a.id + '-' + startTs),
        agent: agentName(a.id),
        surface: a.shift?.surface || a.last?.via || 'unknown',
        state: a.seen?.state || 'quiet',
        statusLabel: a.seen?.label || 'unknown',
        doing: a.now?.doing || '',
        startedAt: startTs,
        startMinutes: startH * 60 + startM,
        startTime: `${pad2(startH)}:${pad2(startM)}`,
        duration,
      };
    });

  if (!shifts.length) return nothing;
  const mode = pf.slotView === 'daily' ? 'daily' : 'gantt';
  const zoom = Math.max(50, Math.min(100, Number(pf.slotZoom) || 100));
  const minH = Math.max(0, Math.min(...shifts.map((s) => Math.floor(s.startMinutes / 60))) - 1);
  const maxH = Math.min(24, Math.max(minH + 6, Math.max(...shifts.map((s) => Math.ceil((s.startMinutes + s.duration) / 60))) + 1));
  const totalMins = Math.max(360, (maxH - minH) * 60);
  const hours = [];
  for (let h = minH; h < maxH; h += 1) hours.push(h);

  const selected = shifts.find((s) => s.id === pf.slotSel) || shifts[0];
  const notes = pf.localSlotNotes || [];

  const addLocalNote = (hour, ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const title = String(form.elements.noteTitle?.value || '').trim();
    const min = Number(form.elements.noteMin?.value || 0);
    if (!title) return;
    pf.localSlotNotes = [...notes, { id: 'ln-' + Date.now(), title, minutes: hour * 60 + min }];
    pf.addHour = null;
    redraw();
  };

  return html`<section class="lm-gantt-wrap" aria-label="Shift timeline">
    <div class="lm-gantt-bar">
      <div class="lmx-filter" role="group" aria-label="Timeline view mode">
        <button type="button" class="lmx-typepill" aria-pressed=${String(mode === 'gantt')} @click=${() => { pf.slotView = 'gantt'; redraw(); }}>Shift Gantt</button>
        <button type="button" class="lmx-typepill" aria-pressed=${String(mode === 'daily')} @click=${() => { pf.slotView = 'daily'; redraw(); }}>Daily slots</button>
      </div>
      ${mode === 'gantt' ? html`<label class="lm-gantt-zoom"><span>Zoom ${Math.round((100 / zoom) * 100)}%</span><input type="range" min="50" max="100" step="5" .value=${String(zoom)} @input=${(e) => { pf.slotZoom = Number(e.currentTarget.value); redraw(); }}></label>` : nothing}
      ${worldClockStrip(now)}
    </div>

    ${mode === 'gantt' ? html`
      <div class="lm-gantt-scroll">
        <div class="lm-gantt-grid" style=${`min-width:${Math.round(640 * (100 / zoom))}px`}>
          <div class="lm-gantt-head">
            <div class="lm-gantt-col-lbl">Agent</div>
            <div class="lm-gantt-axis">${hours.map((h) => html`<span style=${`left:${(((h - minH) * 60) / totalMins) * 100}%`}>${pad2(h)}:00</span>`)}</div>
          </div>
          ${shifts.map((s) => {
            const leftPct = Math.max(0, ((s.startMinutes - minH * 60) / totalMins) * 100);
            const widthPct = Math.max(6, Math.min(100 - leftPct, (s.duration / totalMins) * 100));
            return html`<div class="lm-gantt-row">
              <div class="lm-gantt-col"><a href=${'#/agent/' + encodeURIComponent(s.agent)}>${s.agent}</a><span>${s.surface}</span></div>
              <div class="lm-gantt-lane">
                <button type="button" class="lm-gantt-slot" data-state=${s.state} data-selected=${String(selected.id === s.id)} style=${`left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%`} @click=${() => { pf.slotSel = s.id; redraw(); }}>
                  <strong>${s.doing || 'Shift via ' + s.surface}</strong>
                  <span>${s.startTime} UTC · ${s.statusLabel}</span>
                </button>
              </div>
            </div>`;
          })}
        </div>
      </div>
      ${selected ? html`<div class="lm-gantt-inspect">
        <div><strong>${selected.agent}</strong> <span class="lmx-meta">via ${selected.surface} · started ${relTime(selected.startedAt, now)} (${selected.startTime} UTC)</span><p class="lmx-meta">${selected.doing || 'No active task recorded for this shift.'}</p></div>
        <a class="lm-btn lm-btn--secondary" href=${'#/agent/' + encodeURIComponent(selected.agent)}>Inspect agent →</a>
      </div>` : nothing}
    ` : html`
      <div class="lm-dslots">
        <p class="lmx-meta" style="margin:0 0 8px">Recorded shifts by UTC hour · notes added here stay in this browser session only.</p>
        ${hours.map((h) => {
          const hShifts = shifts.filter((s) => Math.floor(s.startMinutes / 60) === h);
          const hNotes = notes.filter((n) => Math.floor(n.minutes / 60) === h);
          const adding = pf.addHour === h;
          return html`<div class="lm-dslots-row">
            <div class="lm-dslots-head">
              <span class="mono">${pad2(h)}:00 UTC</span>
              <button type="button" class="lm-btn lm-btn--secondary" @click=${() => { pf.addHour = adding ? null : h; redraw(); }}>${adding ? 'Close' : '+ Note'}</button>
            </div>
            ${adding ? html`<form class="lm-dslots-form" @submit=${(ev) => addLocalNote(h, ev)}>
              <input name="noteTitle" class="lm-input" placeholder="Add local slot note…" required>
              <select name="noteMin" class="lm-select"><option value="0">:00</option><option value="15">:15</option><option value="30">:30</option><option value="45">:45</option></select>
              <button type="submit" class="lm-btn lm-btn--primary">Save</button>
            </form>` : nothing}
            ${hShifts.map((s) => html`<div class="lm-dslots-item"><strong>${s.startTime}</strong> · <a href=${'#/agent/' + encodeURIComponent(s.agent)}>${s.agent}</a> — ${s.doing || 'Shift via ' + s.surface}</div>`)}
            ${hNotes.map((n) => html`<div class="lm-dslots-item"><span><strong>${pad2(Math.floor(n.minutes / 60))}:${pad2(n.minutes % 60)}</strong> · ${n.title} <em class="lmx-meta">(local)</em></span><button type="button" class="lmx-linkish" @click=${() => { pf.localSlotNotes = notes.filter((x) => x.id !== n.id); redraw(); }}>Remove</button></div>`)}
          </div>`;
        })}
      </div>
    `}
  </section>`;
}

/** 7. Crisp Agents Roster Table (21st.dev Members Table Block id: 25166) — zero sloppy boxes, zero collapsed drawers. */
export function agentsRosterTable({ agents = [], modes = [], mode = 'fleet', counts = {}, query = '', onQuery, onMode, space, renderAction, initialsOf, avatarOf, now = Date.now() }) {
  const q = String(query || '').trim().toLowerCase();
  const visible = q
    ? agents.filter((a) => {
        const hay = [a.id, a.who?.name, a.who?.role, a.now?.doing, a.recap?.summary, a.shift?.surface].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
    : agents;

  return html`<section class="lm-roster" aria-label="Agent roster">
    <div class="lm-roster-bar">
      <div class="lm-roster-bar-left" role="group" aria-label="Filter the roster">
        ${modes.map(([k, l]) => html`<button type="button" class="lmx-typepill" data-kind=${k} aria-pressed=${String(mode === k)} @click=${() => onMode(k)}>${l} (${counts[k] ?? 0})</button>`)}
      </div>
      <div class="lm-roster-bar-right">
        <label class="lmx-chat-sr" for="agents-roster-search">Search agents</label>
        <input id="agents-roster-search" type="search" class="lm-roster-search" placeholder="Search agents…" .value=${query} @input=${(e) => onQuery(e.currentTarget.value)}>
      </div>
    </div>

    ${visible.length ? html`<div class="lm-roster-scroll">
      <table class="lm-roster-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Current work</th>
            <th>Last recap</th>
            <th>Updated</th>
            <th style="text-align:right">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${visible.map((a) => {
            const name = agentName(a.id);
            const stateKey = a.seen?.state || 'quiet';
            const statusLabel = a.now?.blocked ? 'Blocked' : (a.seen?.label || 'Offline');
            const doing = a.now?.doing ? String(a.now.doing).trim() : '';
            const recapLine = a.recap?.summary ? String(a.recap.summary).split(/\r?\n/).find((l) => l.trim()) || '' : '';
            const lastTs = a.last?.ts || a.shift?.ts || a.recap?.ended_at || 0;
            const logo = avatarOf ? avatarOf(a) : null;
            return html`<tr>
              <td>
                <div class="lm-roster-agent">
                  <span class="lm-roster-avatar" aria-hidden="true">${logo ? html`<img src=${logo} alt="">` : (initialsOf ? initialsOf(a.id) : name.slice(0, 2).toUpperCase())}</span>
                  <div>
                    <a class="lm-roster-name" href=${'#/agent/' + encodeURIComponent(a.id)}>${name}</a>
                    <span class="lm-roster-sub">${a.shift?.surface || a.who?.role || 'agent:' + name}</span>
                  </div>
                </div>
              </td>
              <td>
                <span class="lm-roster-status" data-state=${stateKey} data-blocked=${String(!!a.now?.blocked)}>
                  <span class="lm-roster-sdot" aria-hidden="true"></span>${statusLabel}
                </span>
              </td>
              <td class="lm-roster-work">
                ${doing ? html`<span>${doing.length > 96 ? doing.slice(0, 93) + '…' : doing}</span>` : html`<span class="lm-roster-work-muted">No active task</span>`}
                ${a.now?.job ? html`<div><a class="lmx-jobchip" href=${'#/job/' + encodeURIComponent(String(a.now.job).replace(/^job:/, ''))}>${a.now.job}</a></div>` : nothing}
              </td>
              <td class="lm-roster-recap">
                ${recapLine ? (recapLine.length > 88 ? recapLine.slice(0, 85) + '…' : recapLine) : html`<span class="lm-roster-work-muted">No recap yet</span>`}
              </td>
              <td class="lm-roster-time" title=${lastTs ? fullTime(lastTs) : ''}>${lastTs ? relTime(lastTs, now) : '—'}</td>
              <td>
                <div class="lm-roster-acts">
                  <a class="lm-btn lm-btn--secondary" href=${'#/agent/' + encodeURIComponent(a.id)}>Open</a>
                  ${renderAction ? renderAction(a, space) : nothing}
                </div>
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>` : html`<div style="padding:24px;text-align:center" class="lmx-meta">No agents match this filter.</div>`}

    <div class="lm-roster-foot">
      <span>Showing ${visible.length} of ${agents.length} in current view · reporting activity from the log, not runtime reachability.</span>
      <span>Copy prompt puts a ready prompt on your clipboard without starting a process.</span>
    </div>
  </section>`;
}
