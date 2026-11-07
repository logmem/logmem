// fleet-truth-view.js — the read-only fleet-truth board at #/channels/fleet-truth (approach A).
// It reads channel Who and Now through the `channels` view (data.js load). No write controls exist here:
// the board is a read of what the scheduled runner wrote. Other channels keep the old Log page.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { ago, toast } from './core.js';
import { load } from './data.js';
import { icon, idChip, emptyState, entries, moreMenu, fresh } from './ui.js';
import { renderView } from './shell.js';
import { CHANNEL_ID, FRESH_MS, TAGS, TAG_ORDER, readBoard, slotLabel, visibleFacts, correctionText } from './fleet-truth-model.js';

// data-d borrows the colour of an existing decision chip. The word and icon are ours.
const CHIP_D = { verified: 'approved', reported: 'deferred', unknown: 'blocked', stale: 'pending' };
const on = { verified: true, reported: true, unknown: true, stale: true };
let lastDraw = null;
let alertedFor = null;

export function evidenceChip(tag, odd) {
  const t = TAGS[tag] || TAGS.unknown;
  const word = odd ? 'Unknown tag: ' + odd : t.word;
  return html`<span class="lm-decision lmx-ft-chip" data-d=${CHIP_D[tag] || 'blocked'} title=${t.tip}>${icon(t.icon)}<span class="lmx-ft-sr">Status: </span>${word}<span class="lmx-ft-sr">. ${t.tip}</span></span>`;
}

const when = (iso) => { const ms = Date.parse(iso); return Number.isFinite(ms) ? 'seen ' + ago(ms) : 'Time not recorded'; };
const copyText = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy. Select the text and copy it.', true));

export function factRow(f, trail) {
  const fix = html`<button type="button" class="lm-btn lm-btn--ghost" @click=${() => copyText(correctionText(f, trail))}>Copy correction text</button>`;
  return html`<article class="lmx-card lmx-ft-fact" data-tag=${f.tag}>
    <div class="lmx-ft-top">${evidenceChip(f.tag, f.oddTag)}</div>
    <p class="lmx-ft-claim">${f.claim}</p>
    <div class="lmx-meta">${f.source
      ? html`source: ${f.sourceUrl ? html`<a href=${f.sourceUrl} target="_blank" rel="noopener noreferrer">${f.source}</a>` : f.source}`
      : html`<span class="lmx-flag">Source not recorded</span>`}
      ${f.verifiedBy ? html` · verified by: ${f.verifiedBy}` : f.verifiedByMissing ? html` · <span class="lmx-flag">verified by: not recorded</span>` : nothing}
      · ${when(f.observedAt)}</div>
    <div class="lmx-ft-acts">${f.source && !f.sourceUrl && f.source.length > 14 ? idChip(f.source, 'source') : nothing}${f.verifiedBy && f.verifiedBy.length > 14 ? idChip(f.verifiedBy, 'by') : nothing}${moreMenu([fix])}</div>
  </article>`;
}

function sectionBlock(s, board) {
  const shown = visibleFacts(s.facts, on);
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 639px)').matches;
  return html`<details class="lmx-ft-section" ?open=${s.open || !phone}>
    <summary class="lmx-colhead"><span>${s.label}</span> <b>${s.facts.length}</b></summary>
    <div class="lmx-stack">${!s.present || !s.facts.length ? html`<p class="lmx-meta">Not reported in this refresh.</p>`
      : shown.length ? shown.map((f) => factRow(f, board.trail)) : html`<p class="lmx-meta">No rows match the tags switched on.</p>`}</div>
  </details>`;
}

function boardBlock(board) {
  const slot = slotLabel(board.slot);
  const ms = board.refreshedMs;
  const shownCount = board.sections.reduce((n, s) => n + visibleFacts(s.facts, on).length, 0);
  const announce = board.stale && alertedFor !== board.refreshedAt;
  if (announce) alertedFor = board.refreshedAt;
  return html`<section class="lmx-ft-board" aria-label="Fleet truth board">
    <div class="lmx-ft-line" role="status">${ms ? (slot ? slot + ', ' : 'Refreshed ') + ago(ms) : 'Refresh time not recorded'}
      ${fresh(board.stale ? 'stale' : 'fresh')}
      <span class="lmx-meta">${board.runner ? 'runner: ' + board.runner : 'runner not recorded'}${ms ? ' · default window ' + FRESH_MS / 3600e3 + ' h' : ''}</span></div>
    ${board.stale ? html`<div class="lm-alert lm-alert--warning" role=${announce ? 'alert' : nothing}>${icon('clock')}<div>This board is older than the expected refresh. Treat every row as stale. Row tags show what the runner wrote.</div></div>` : nothing}
    ${board.chips.length ? html`<div class="lmx-ft-chips">${board.chips.map((c) => html`<span class="lmx-ft-sum"><b>${c.label}:</b> ${c.value}</span>`)}</div>`
      : board.summary ? html`<p class="lmx-meta">${board.summary}</p>` : html`<p class="lmx-meta">Summary not recorded</p>`}
    <div class="lmx-ft-filter" role="group" aria-label="Show tags">${TAG_ORDER.map((t) => html`<button type="button" class="lm-btn lm-btn--secondary" aria-pressed=${String(on[t])} @click=${() => { on[t] = !on[t]; if (lastDraw) lastDraw(); }}>${TAGS[t].word} ${board.counts[t]}</button>`)}</div>
    <p class="lmx-ft-sr" role="status">Showing ${shownCount} of ${board.total} rows.</p>
    ${board.sections.map((s) => sectionBlock(s, board))}
  </section>`;
}

/** Draw the page for a loaded `channels` reply. Exported so callers use the same path. */
export function fleetTruthPage(d) {
  // The backend falls back to the first channel when the id is unknown. Only trust Who and Now for ours.
  const mine = d.selected === CHANNEL_ID;
  const board = readBoard(mine ? d.now : null);
  const log = mine ? d.log : [];
  let top;
  if (board.state === 'ok') top = boardBlock(board);
  else if (board.state === 'schema') top = html`<div class="lm-alert lm-alert--warning">${icon('alert')}<div>This board uses a schema this app does not read (${board.schema}). Showing raw entries below.</div></div>`;
  else top = emptyState('No fleet truth board yet.', 'The first board appears after a supervised seed. Until then, coordination memos are not a source of truth. Ask the operator who owns the seed.');
  renderView('channels', ['Knowledge', 'Fleet truth'], html`<div class="lmx-ft">
    <div class="lmx-work-toolbar"><h1>Fleet truth</h1><a href="#/knowledge">Knowledge</a></div>
    ${top}
    <section aria-labelledby="ft-log"><h2 class="lmx-colhead" id="ft-log">Log</h2>${entries(log, 'No entries on this channel yet.')}</section>
  </div>`);
}

/** Wrap pages.channels: #/channels/fleet-truth draws the board, every other channel keeps the old page. */
export function registerFleetTruth(pages, ok) {
  const plain = pages.channels;
  pages.channels = async (id) => {
    if (id !== CHANNEL_ID) return plain(id);
    const d = await load('channels', { id });
    if (!ok(d)) return;
    lastDraw = () => fleetTruthPage(d);
    lastDraw();
  };
  return pages;
}
