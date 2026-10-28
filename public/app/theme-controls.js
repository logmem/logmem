// Shared palette control for the dashboard and account tools.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { THEMES, readTheme, writeTheme } from './theme.js';

export function themeControl(onChange = () => {}) {
  const selected = document.documentElement.dataset.appTheme || readTheme();
  return html`<fieldset class="lmx-palette"><legend>Theme</legend>${THEMES.map(theme => html`<label class="lmx-palette-choice" data-palette=${theme} title=${theme[0].toUpperCase() + theme.slice(1)}><input type="radio" name="lm-theme" value=${theme} aria-label=${theme[0].toUpperCase() + theme.slice(1) + ' theme'} .checked=${selected === theme} @change=${event => { if (event.target.checked) { writeTheme(theme); onChange(); } }}><span class="lmx-palette-dot" aria-hidden="true"></span></label>`)}</fieldset>`;
}
