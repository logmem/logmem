// Keep spatial mode as the default and store the user's choice across routes.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';

const KEY = 'logmem-map-view';
function readMode() {
  try { return localStorage.getItem(KEY) === 'table' ? 'table' : 'spatial'; }
  catch { return 'spatial'; }
}
function setMode(mode) {
  document.documentElement.dataset.mapMode = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* Keep the in-memory choice. */ }
  document.querySelectorAll('.lmx-map-toggle button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.view === mode));
  });
}
if (typeof document !== 'undefined') document.documentElement.dataset.mapMode = readMode();

export function mapViewToggle() {
  const mode = typeof document === 'undefined' ? 'spatial' : document.documentElement.dataset.mapMode || readMode();
  return html`<div class="lmx-map-toggle" role="group" aria-label="Page layout">
    <button type="button" data-view="spatial" aria-pressed=${String(mode === 'spatial')} @click=${() => setMode('spatial')}><span aria-hidden="true">◉</span> Spatial</button>
    <button type="button" data-view="table" aria-pressed=${String(mode === 'table')} @click=${() => setMode('table')}><span aria-hidden="true">▤</span> Table</button>
  </div>`;
}
