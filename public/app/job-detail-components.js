// job-detail-components.js: the Next panel and the Handoff panel for a job, from the canvas JobDetail.
// d is the job view. Each panel returns nothing when the view has no field for it.
import { html, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { agentName, ago } from './core.js';
import { icon } from './ui.js';
import { jobNext, jobHandoff } from './canvas-detail-model.js';

export function jobNextPanel(d) {
  const n = jobNext(d);
  if (!n) return nothing;
  const label = n.who === 'you' ? 'Next: you.' : n.who === 'blocked' ? 'Blocked.' : 'Next: ' + agentName(n.who) + '.';
  return html`<div class="lm-alert lmx-next-step" data-who=${n.who} role="status">${icon(n.who === 'you' ? 'decisions' : n.who === 'blocked' ? 'pause' : 'arrow-right')}<div><strong>${label}</strong> ${n.text}</div></div>`;
}

export function jobHandoffPanel(d) {
  const h = jobHandoff(d && d.log);
  if (!h) return nothing;
  const badge = h.acceptedMin != null ? html`<span class="lm-badge lm-badge--success">accepted in ${h.acceptedMin} min</span>` : html`<span class="lm-badge lm-badge--warning">not accepted yet</span>`;
  return html`<section class="lm-panel lmx-handoff-panel" aria-label="Handoff"><div class="lm-panel-head"><h2 class="lm-title-2" style="margin:0;font-size:17px">Handoff</h2><span class="lm-spacer"></span>${badge}</div>
    <div class="lmx-handoff-body"><div class="lm-handoff"><span class="lmx-handoff-agent">${agentName(h.from)}</span><span class="lm-handoff-arrow">${icon('handoff')}<span class="lmx-meta">${ago(h.ts)}</span></span>${h.to ? html`<span class="lmx-handoff-agent">${agentName(h.to)}</span>` : nothing}</div>
    ${h.message ? html`<p class="lmx-handoff-msg">${h.message}</p>` : nothing}</div></section>`;
}

/** Both panels, ready for the top of the job drawer. */
export const jobDetailPanels = (d) => html`${jobNextPanel(d)}${jobHandoffPanel(d)}`;
