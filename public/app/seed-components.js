// seed-components.js: the "fill this space from a project" card. It copies a prompt; the person pastes it
// into the AI that holds their chats, files and repo. Text reaches the page only as text nodes.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { seedPrompt, developerSeedPrompt } from './seed-prompt.js';
import { agentDispatchButton } from './dispatch-components.js';

/** project is the space's display name. The prompt makes the agent stop if the connected space is not for it. */
export function seedCard({ project }) {
  const name = String(project || '').trim() || undefined;
  return html`<section class="lm-panel lmx-seed" aria-label="Fill this space from a project">
    <h2 class="lm-title-2">Fill this space from a project</h2>
    <p class="lmx-meta">One project is one space. Copy a prompt, paste it into the AI that knows your work, and it reads first, asks you questions, shows a draft, and writes only after you approve. <a href="/how-to#seed">How it works</a></p>
    <div class="lmx-seed-actions">${agentDispatchButton(seedPrompt(name), 'Copy seed prompt')}${agentDispatchButton(developerSeedPrompt(name), 'Copy for a software project')}</div>
  </section>`;
}
