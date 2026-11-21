// Local logo choices and portable identity exports for one agent profile.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { toast } from './core.js';
import { LOBEHUB_ICONS } from './lobehub-icons.js';
import { agentIcon, saveAgentIcon } from './agent-icons.js';

const safeId = (value) => String(value || 'agent').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
const pageUrl = (id) => `${location.origin}/app#/agent/${encodeURIComponent(id)}`;

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportModel({ d, id, space }) {
  const who = d.who || {}, logo = agentIcon(space, id);
  const title = String(who.name || id);
  const description = String(who.role || '');
  const avatar = logo ? new URL(logo.src, location.origin).href : '';
  return {
    title,
    description,
    logo,
    data: {
      author: 'LogMem',
      config: { systemRole: '' },
      homepage: pageUrl(id),
      identifier: safeId(id),
      locale: 'en-US',
      meta: { avatar, tags: [], title, description },
    },
  };
}

function exportJson(context) {
  const model = exportModel(context);
  download(`logmem-${safeId(context.id)}-profile.json`, JSON.stringify(model.data, null, 2) + '\n', 'application/json');
}

function exportMarkdown(context) {
  const model = exportModel(context);
  const lines = [
    `# ${model.title}`,
    '',
    `- Identifier: ${context.id}`,
    `- Description: ${model.description || 'No role description is stored.'}`,
    `- Logo: ${model.logo ? `[${model.logo.label}](${new URL(model.logo.src, location.origin).href})` : 'Not set'}`,
    `- Profile: ${pageUrl(context.id)}`,
    '',
    '## System role',
    '',
    'LogMem does not store a system prompt for this profile. The JSON export leaves `config.systemRole` empty.',
    '',
  ];
  download(`logmem-${safeId(context.id)}-profile.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
}

function filterIcons(event) {
  const query = event.currentTarget.value.trim().toLowerCase();
  const dialog = event.currentTarget.closest('dialog');
  const options = [...dialog.querySelectorAll('[data-lobe-icon]')];
  let visible = 0;
  for (const option of options) {
    const match = !query || option.dataset.iconSearch.includes(query);
    option.hidden = !match;
    if (match) visible++;
  }
  const empty = dialog.querySelector('[data-icon-empty]');
  if (empty) empty.hidden = visible !== 0;
  dialog.querySelector('[data-icon-count]').textContent = `${visible} of ${options.length} logos`;
}

/** Profile identity buttons and a native, keyboard-safe icon picker. */
export function profileTools(context) {
  const selected = agentIcon(context.space, context.id);
  const choose = (slug) => (event) => {
    const saved = saveAgentIcon(context.space, context.id, slug);
    event.currentTarget.closest('dialog').close();
    if (!saved) toast('Could not save this logo in the browser.', true);
    else toast(slug ? 'Logo saved for this space in this browser.' : 'Automatic logo restored.');
    context.redraw();
  };
  const openPicker = (event) => {
    const dialog = event.currentTarget.closest('.lmx-prof-tools').querySelector('dialog');
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => dialog.querySelector('input')?.focus({ preventScroll: true }));
  };
  return html`<div class="lmx-prof-tools">
    <div class="lmx-prof-actions" role="group" aria-label="Agent profile tools">
      <button type="button" class="lm-btn lm-btn--secondary" @click=${openPicker}>${selected ? 'Change logo' : 'Choose logo'}</button>
      <button type="button" class="lm-btn lm-btn--secondary" @click=${() => exportJson(context)}>Export LobeHub JSON</button>
      <button type="button" class="lm-btn lm-btn--ghost" @click=${() => exportMarkdown(context)}>Export Markdown</button>
    </div>
    <p class="lmx-meta">Logo choices stay in this browser and workspace. Exports include the visible identity and logo. They exclude Now, activity, and follows.</p>
    <dialog class="lmx-logo-dialog" aria-labelledby="lmx-logo-title" @click=${(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <header class="lmx-logo-dialog-head"><div><span class="lm-eyebrow">LOBEHUB ICONS</span><h2 id="lmx-logo-title">Choose a logo for ${context.id}</h2></div><button type="button" class="lm-btn lm-btn--ghost" aria-label="Close logo picker" @click=${(event) => event.currentTarget.closest('dialog').close()}>Close</button></header>
      <label class="lm-field lmx-logo-search"><span>Search logos</span><input class="lm-input" type="search" autocomplete="off" placeholder="Search 357 AI logos" @input=${filterIcons}></label>
      <p class="lmx-meta" data-icon-count>${LOBEHUB_ICONS.length} logos</p>
      <div class="lmx-logo-grid" role="group" aria-label="LobeHub AI logos">
        <button type="button" class="lmx-logo-option lmx-logo-option--auto" @click=${choose('')}><span class="lmx-logo-auto-mark" aria-hidden="true">Aa</span><span>Automatic</span></button>
        ${LOBEHUB_ICONS.map((icon) => html`<button type="button" class="lmx-logo-option" data-lobe-icon data-icon-search=${(icon.slug + ' ' + icon.label).toLowerCase()} aria-label=${'Select ' + icon.label + ' logo'} @click=${choose(icon.slug)}><img src=${icon.src} alt="" loading="lazy" decoding="async"><span>${icon.label}</span></button>`)}
      </div>
      <p class="lmx-meta" data-icon-empty hidden>No logos match. Try a shorter search.</p>
      <p class="lmx-meta">These 357 SVG logos come from LobeHub. The picker stores only your visual choice on this device.</p>
    </dialog>
  </div>`;
}
