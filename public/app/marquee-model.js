// marquee-model.js: the pure part of the auto-scroll, so node can test it.
export const SPEED = 0.45; // pixels per frame at 60 fps
export const REST_MS = 1800;

/** Pure step: where the strip goes next. Returns { pos, dir, restUntil }. */
export function nextScroll({ pos, dir, max, now, restUntil, speed = SPEED }) {
  if (max <= 4 || now < restUntil) return { pos, dir, restUntil };
  const to = pos + dir * (dir < 0 ? speed * 6 : speed);
  if (to >= max) return { pos: max, dir: -1, restUntil: now + REST_MS };
  if (to <= 0) return { pos: 0, dir: 1, restUntil: now + REST_MS };
  return { pos: to, dir, restUntil };
}
