import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nextScroll, REST_MS, SPEED } from "../public/app/marquee-model.js";

test("marquee: moves right at a steady pace and rests at both ends", () => {
  const a = nextScroll({ pos: 0, dir: 1, max: 1000, now: 100, restUntil: 0 });
  assert.equal(a.dir, 1);
  assert.ok(a.pos > 0 && a.pos <= SPEED + 1e-9);
  const end = nextScroll({ pos: 999.9, dir: 1, max: 1000, now: 500, restUntil: 0 });
  assert.equal(end.pos, 1000);
  assert.equal(end.dir, -1);
  assert.equal(end.restUntil, 500 + REST_MS);
  const rest = nextScroll({ pos: 1000, dir: -1, max: 1000, now: 600, restUntil: 500 + REST_MS });
  assert.equal(rest.pos, 1000);
  const home = nextScroll({ pos: 1, dir: -1, max: 1000, now: 9000, restUntil: 0 });
  assert.equal(home.pos, 0);
  assert.equal(home.dir, 1);
});

test("marquee: a strip that fits does not move", () => {
  const a = nextScroll({ pos: 0, dir: 1, max: 3, now: 100, restUntil: 0 });
  assert.equal(a.pos, 0);
});

test("handoff strip: cards are buttons with a popover, the strip can be paused and honours reduced motion", () => {
  const views = readFileSync(new URL("../public/app/flow-views.js", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/app/marquee.js", import.meta.url), "utf8");
  assert.match(views, /popovertarget=/);
  assert.match(views, /Pause scrolling/);
  assert.match(views, /aria-label="Waiting handoffs, oldest first"/);
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /pointerenter/);
  assert.match(js, /focusin/);
});
