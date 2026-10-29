// Shared palette control for the dashboard and account tools.
import { html } from '/vendor/lit-html-3.2.1/lit-html.js';
import { THEMES, readTheme, writeTheme } from './theme.js';

export function themeControl(onChange = () => {}) {
  const selected = document.documentElement.dataset.appTheme || readTheme();
  return html`<details class="lmx-theme-picker" @keydown=${event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary').focus();}}}><summary aria-label=${'Theme: ' + selected}><span>Theme</span><span class="lmx-theme-current" data-palette=${selected} aria-hidden="true"></span><span aria-hidden="true">⌄</span></summary><fieldset class="lmx-palette"><legend>Choose a theme</legend>${THEMES.map(theme => html`<label class="lmx-palette-choice" data-palette=${theme} title=${theme[0].toUpperCase() + theme.slice(1)}><input type="radio" name="lm-theme" value=${theme} aria-label=${theme[0].toUpperCase() + theme.slice(1) + ' theme'} .checked=${selected === theme} @change=${event => { if (event.target.checked) { writeTheme(theme); event.currentTarget.closest('details').open=false; onChange(); } }}><span class="lmx-palette-dot" aria-hidden="true"></span></label>`)}</fieldset></details>`;
}
