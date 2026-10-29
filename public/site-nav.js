// site-nav.js: builds the one site menu into header.nav[data-site-nav]. The static links in the page stay as the no-script fallback.
// Desktop: links with a small button that opens each sub menu. Phone: a menu button that opens a panel with the same sub menus.
import { MENU, CTA, WIDE_AFTER } from './site-nav-model.js';

const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  n.append(...kids);
  return n;
};
const BREAKPOINT = '(max-width: 1000px)';

function build(header) {
  const current = header.dataset.current || '';
  const path = location.pathname.replace(/\/$/, '') || '/';
  const here = href => href.split('#')[0].replace(/\/$/, '') === path && !href.includes('#');
  const list = el('ul', { class: 'nav-list' });
  const subButtons = [];
  for (const item of MENU) {
    const li = el('li', { class: 'nav-item' });
    li.append(el('a', { href: item.href, 'aria-current': item.id === current ? 'page' : false }, [item.label]));
    if (item.sub) {
      const id = 'nav-sub-' + item.id;
      const btn = el('button', { type: 'button', class: 'nav-sub-toggle', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': item.label + ' menu' }, [el('span', { 'aria-hidden': 'true', class: 'nav-chev' })]);
      const sub = el('ul', { id, class: 'nav-sub' + (item.sub.length > WIDE_AFTER ? ' nav-sub--wide' : ''), hidden: true });
      for (const s of item.sub) sub.append(el('li', {}, [el('a', { href: s.href, 'aria-current': here(s.href) ? 'page' : false }, [s.label])]));
      li.append(btn, sub);
      subButtons.push(btn);
    }
    list.append(li);
  }
  const hasCta = !!header.querySelector(':scope > .lm-btn');
  const menuCta = hasCta ? el('a', { class: 'lm-btn lm-btn--primary nav-menu-cta', href: CTA.href }, [CTA.label]) : null;
  const extra = el('div', { id: 'nav-extra', class: 'nav-extra' });
  const nav = el('nav', { id: 'site-menu', 'aria-label': 'Main' }, [list, ...(menuCta ? [menuCta] : []), extra]);
  header.querySelector('nav')?.replaceWith(nav);
  header.querySelector(':scope > .lm-btn')?.classList.add('nav-cta');
  const toggle = el('button', { type: 'button', class: 'nav-toggle', 'aria-expanded': 'false', 'aria-controls': 'site-menu', 'aria-label': 'Menu' }, [el('span', { class: 'nav-bars', 'aria-hidden': 'true' })]);
  header.append(toggle);

  const subOf = btn => document.getElementById(btn.getAttribute('aria-controls'));
  const closeSubs = except => subButtons.forEach(b => { if (b !== except) { b.setAttribute('aria-expanded', 'false'); subOf(b).hidden = true; } });
  const setMenu = open => { header.toggleAttribute('data-open', open); toggle.setAttribute('aria-expanded', String(open)); if (!open) closeSubs(); };
  toggle.addEventListener('click', () => setMenu(!header.hasAttribute('data-open')));
  subButtons.forEach(b => b.addEventListener('click', () => {
    const open = b.getAttribute('aria-expanded') !== 'true';
    closeSubs(b);
    b.setAttribute('aria-expanded', String(open));
    subOf(b).hidden = !open;
  }));
  document.addEventListener('click', e => { if (!header.contains(e.target)) { closeSubs(); setMenu(false); } });
  header.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const openSub = subButtons.find(b => b.getAttribute('aria-expanded') === 'true');
    if (openSub) { closeSubs(); openSub.focus(); } else if (header.hasAttribute('data-open')) { setMenu(false); toggle.focus(); }
  });
  matchMedia(BREAKPOINT).addEventListener('change', e => { if (!e.matches) setMenu(false); });
  document.dispatchEvent(new CustomEvent('site-nav-ready'));
}

const header = document.querySelector('header.nav[data-site-nav]');
if (header) build(header);
