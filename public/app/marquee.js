// marquee.js: a gentle auto-scroll for a strip of cards. It scrolls to the end, rests, then glides back.
// It stops while the pointer or focus is inside, while a finger is down, when the tab is hidden, when the
// strip is off screen, under reduced motion, and when the Pause button is on (data-paused="true").
// The strip stays an ordinary scrollable list, so wheel, trackpad, touch and keyboard all still work.
import { Directive, directive, PartType } from '/vendor/lit-html-3.2.1/directive.js';
import { nothing } from '/vendor/lit-html-3.2.1/lit-html.js';
import { nextScroll, REST_MS } from './marquee-model.js';

const running = new WeakSet();

export function autoScroll(el) {
  if (!el || running.has(el)) return;
  running.add(el);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let held = false, onScreen = true, pos = el.scrollLeft, dir = 1, restUntil = performance.now() + REST_MS, touching = false;
  const hold = on => () => { held = on; };
  el.addEventListener('pointerenter', hold(true));
  el.addEventListener('pointerleave', hold(false));
  el.addEventListener('focusin', hold(true));
  el.addEventListener('focusout', hold(false));
  el.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  el.addEventListener('touchend', () => { setTimeout(() => { touching = false; }, 2500); }, { passive: true });
  new IntersectionObserver(([e]) => { onScreen = e ? e.isIntersecting : true; }).observe(el);
  const tick = now => {
    if (!el.isConnected) { running.delete(el); return; }
    const paused = held || touching || !onScreen || reduce.matches || el.dataset.paused === 'true' || document.visibilityState === 'hidden';
    if (Math.abs(el.scrollLeft - Math.round(pos)) > 1) pos = el.scrollLeft; // someone scrolled by hand
    if (!paused) {
      const next = nextScroll({ pos, dir, max: el.scrollWidth - el.clientWidth, now, restUntil });
      pos = next.pos; dir = next.dir; restUntil = next.restUntil;
      if (Math.round(pos) !== el.scrollLeft) el.scrollLeft = pos;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

class AutoScrollDirective extends Directive {
  constructor(info) {
    super(info);
    if (info.type !== PartType.ELEMENT) throw new Error('autoScrollOn goes on an element');
  }
  render() { return nothing; }
  update(part) { autoScroll(part.element); return nothing; }
}
/** Use as <ul ${autoScrollOn()}>. */
export const autoScrollOn = directive(AutoScrollDirective);
