// log-components.js — Log list rows, selected-entry inspector, group-by control and Recall result cards.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago, hhmm, agentName } from './core.js';
import { textWithIds, idChip } from './ui.js';
import { GROUP_BY, SHIFT_NOTE, entryKey, trailChain, techFields, jobIdOf, highlightParts, matchedTerms, recallRow } from './log-model.js';

const stamp = (ts) => (Number(ts) > 0 ? new Date(Number(ts)).toUTCString().replace(' GMT', ' UTC') : 'Time unavailable');

export const groupControl = (mode, set) => html`<div class="lm-seg lmx-groupby" role="group" aria-label="Group by">${GROUP_BY.map(([k, l]) => html`<button type="button" aria-pressed=${String(mode === k)} @click=${() => set(k)}>${l}</button>`)}</div>`;

export const shiftMarker = (r) => html`<div class="lm-session" data-cold=${r.state === 'cold' ? '' : nothing}><span class="lm-carry"></span><span class="lm-eyebrow">${r.agent} · shift ${hhmm(r.start)} · ${SHIFT_NOTE[r.state] || ''}</span></div>`;

export function logRow(e, selKey, pick) {
  const on = entryKey(e) === selKey;
  return html`<div class="lm-event lmx-logrow" data-k=${e.group || ''} role="button" tabindex="0" aria-pressed=${String(on)} aria-selected=${String(on)}
    @click=${() => pick(e)} @keydown=${(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(e); } }}>
    <time class="lm-event-time time">${hhmm(e.ts)}</time><span class="lm-event-rule" aria-hidden="true"></span>
    <div class="lm-event-main"><div class="lm-event-line"><span class="lm-kind">${e.kind || 'entry'}</span><strong style="font-size:14px">${agentName(e.by) || 'unknown'}</strong><span class="lm-event-summary">${textWithIds(e.summary)}</span></div>
    <div class="lm-prov"><span>${textWithIds(e.where)}</span>${e.trail ? html`<span>${idChip(e.trail, 'trail')}</span>` : nothing}${e.origin ? html`<span>↳ ${idChip(e.origin, 'origin')}</span>` : nothing}${e.via ? html`<span>via ${e.via}</span>` : nothing}</div></div></div>`;
}

export function logList(rows, selKey, pick) {
  return html`<div class="lm-events">${rows.map((r) => r.type === 'shift' ? shiftMarker(r) : r.type === 'head' ? html`<div class="lm-session"><span class="lm-eyebrow">Trail ${r.label} · ${r.count} ${r.count === 1 ? 'entry' : 'entries'}</span></div>` : logRow(r.e, selKey, pick))}</div>`;
}

/** The inspector. At most three visible controls: Close, one action link, Tech view. */
export function inspector({ sel, all, close }) {
  if (!sel) return nothing;
  const chain = trailChain(all, sel), me = entryKey(sel), job = jobIdOf(sel.where);
  const approval = sel.kind === 'approval';
  return html`<aside class="lm-panel lmx-inspector" aria-label="Selected entry">
    <div class="lm-panel-head"><span class="lm-kind" data-k=${sel.group || ''}>${sel.kind || 'entry'}</span><h2 class="lm-title-3" style="margin:0;font-size:14px">${agentName(sel.by) || 'unknown'}, ${hhmm(sel.ts)}</h2><span class="lm-spacer"></span><button type="button" class="lm-btn lm-btn--ghost lmx-inspector-x" aria-label="Close selected entry" @click=${close}>Close</button></div>
    <div class="lmx-inspector-body">
      <p class="lmx-inspector-summary">${textWithIds(sel.summary)}</p>
      <dl class="lm-kv"><dt>by</dt><dd class="lm-mono">${sel.by || 'unknown'}${sel.via ? ` (via ${sel.via})` : ''}</dd><dt>where</dt><dd class="lm-mono">${sel.where || 'unknown'}</dd>
        <dt>trail</dt><dd class="lm-mono">${sel.trail ? idChip(sel.trail) : 'none'}</dd>${sel.origin ? html`<dt>origin</dt><dd class="lm-mono">${idChip(sel.origin)}</dd>` : nothing}
        ${sel.shift ? html`<dt>shift</dt><dd class="lm-mono">${sel.shift}</dd>` : nothing}<dt>written</dt><dd>${stamp(sel.ts)}${sel.ts ? ' · ' + ago(sel.ts) : ''}</dd></dl>
      <div class="lmx-inspector-chain"><span class="lm-eyebrow">This trail</span>
        <ol class="lm-chain">${chain.map((c) => html`<li data-k=${c.group || ''} style="--k:var(--viz-${({ work: 1, handoff: 2, signal: 3, decision: 4, error: 5, system: 6 })[c.group] || 6})" aria-current=${entryKey(c) === me ? 'step' : nothing}><span class="lm-node"></span><span style="font-size:13px"><strong>${c.kind || 'entry'}</strong> · ${agentName(c.by) || 'unknown'} · ${hhmm(c.ts)}</span></li>`)}</ol>
        ${chain.length < 2 ? html`<p class="lmx-meta">No other entry in this window shares this trail.</p>` : nothing}</div>
      <div class="lm-row">${approval ? html`<a href="#/queue" class="lm-btn lm-btn--decision" style="text-decoration:none">Review decision</a>` : job ? html`<a href=${'#/job/' + encodeURIComponent(job)} class="lm-btn lm-btn--secondary" style="text-decoration:none">Open job</a>` : nothing}</div>
      <details class="lm-disclosure"><summary>Tech view</summary><pre class="lm-mono lmx-tech">${Object.entries(techFields(sel)).map(([k, v]) => `${k.padEnd(10)}${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n') || 'No raw fields.'}</pre></details>
    </div></aside>`;
}

const marked = (text, terms) => highlightParts(text, terms).map((p) => (p.hit ? html`<mark>${p.text}</mark>` : p.text));

export const recallExplainer = () => html`<div class="lm-alert lm-alert--info lmx-recall-note" role="note"><div style="font-size:13px"><strong>Matching by words.</strong> No meaning-based index is attached to this space, so results contain your words. Results are ranked by how many of them match, then by date.</div></div>`;

/** One recall result: quote block, matched words, open original. */
export function recallCard(raw, terms, open) {
  const r = recallRow(raw), hit = matchedTerms(r.summary, terms);
  return html`<article class="lm-recall lmx-recall"><div class="lm-row"><span class="lm-kind">${r.kind}</span>${r.by ? html`<strong style="font-size:14px">${r.by}</strong>` : nothing}<span class="lm-mono lmx-meta">${r.from || 'unknown'}</span><span class="lmx-meta lmx-recall-when">${r.ts ? stamp(r.ts) + ' · ' + ago(r.ts) : 'Time unavailable'}</span></div>
    <blockquote class="lm-recall-quote">${marked(r.summary, terms)}</blockquote>
    <div class="lm-recall-meta"><span>matched ${hit.length ? hit.join(', ') : 'by words in the entry'}</span><a href="#/log" class="lmx-recall-open" @click=${(ev) => { ev.preventDefault(); open(r); }}>Open original entry</a></div></article>`;
}
