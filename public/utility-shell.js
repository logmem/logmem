// Keep standalone account tools inside the current dashboard navigation and theme.
import { html, render, nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { NAV, ADMIN } from '/app/shell.js';
import { icon } from '/app/ui.js';
import { THEMES, readTheme, writeTheme } from '/app/theme.js';

const content = document.getElementById('root');
const page = document.body.dataset.utility;
const label = page === 'keys' ? 'Agent keys' : 'Connections';
const params = new URLSearchParams(location.search);
let operator = page === 'keys' || params.get('operator') === '1';
try {
  const source = new URL(document.referrer);
  if (source.origin === location.origin && source.pathname === '/app') {
    operator ||= source.searchParams.get('operator') === '1';
  }
} catch { /* A direct visit has no referring dashboard. */ }
const dashboard = operator ? '/app?operator=1' : '/app';
function href(item) {
  const target = item[3] || '#/' + item[0];
  if (target.startsWith('#/')) return dashboard + target;
  if (operator && ['/keys', '/connections'].includes(target)) return target + '?operator=1';
  return target;
}
const navItem = item => html`<a class="lm-nav-item" aria-label=${item[1]} title=${item[1]} href=${href(item)} aria-current=${item[0] === page ? 'page' : nothing}>${icon(item[2])}<span>${item[1]}</span></a>`;
const brand = html`<a href=${dashboard} aria-label="LogMem dashboard"><img class="logo-l" src="/ds/logos/logmem-lockup.svg" alt="LogMem"><img class="logo-d" src="/ds/logos/logmem-lockup-reversed.svg" alt="LogMem"></a>`;
const shell = document.createElement('div');
shell.className = 'lmx lmx-utility-shell';
content.before(shell);
render(html`
  <a class="lmx-utility-skip" href="#root">Skip to content</a>
  <nav class="lmx-rail" aria-label="Dashboard navigation">
    <div class="lm-rail-brand">${brand}</div>
    ${NAV.map(navItem)}
    <p class="lmx-sep">Settings</p>
    ${ADMIN.map(navItem)}
    <div class="lm-rail-foot"><a class="lm-btn lm-btn--ghost lmx-railtext" href=${dashboard}>Back to dashboard</a></div>
  </nav>
  <div class="lmx-col">
    <header class="lmx-head">
      <ol class="lm-crumbs"><li><a href=${dashboard + '#/settings'}>Settings</a></li><li aria-hidden="true">/</li><li aria-current="page">${label}</li></ol>
      <label class="lmx-theme-picker"><span>Theme</span><select class="lm-select" aria-label="Theme" @change=${event => writeTheme(event.target.value)}>${THEMES.map(theme => html`<option value=${theme} ?selected=${theme === readTheme()}>${theme[0].toUpperCase() + theme.slice(1)}</option>`)}</select></label>
      <a class="lm-btn lm-btn--ghost" href=${dashboard}>Back to dashboard</a>
    </header>
    <nav class="lmx-utility-mobile" aria-label="Page navigation">${ADMIN.map(navItem)}</nav>
    <div class="lmx-workarea" id="utility-content"></div>
  </div>`, shell);
content.removeAttribute('style');
content.classList.add('lmx-main', 'lmx-utility-content');
content.tabIndex = -1;
shell.querySelector('#utility-content').append(content);
// Keep the selected tool visible in the phone's scrolling navigation row.
const mobileNav = shell.querySelector('.lmx-utility-mobile');
const selectedLink = mobileNav.querySelector('[aria-current="page"]');
if (selectedLink) mobileNav.scrollLeft = selectedLink.offsetLeft - mobileNav.offsetLeft;
