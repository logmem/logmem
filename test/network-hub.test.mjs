import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { NODES, STEPS, LAYOUTS } from "../public/network-hub.js";

const read = p => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const box = (cx, cy, w, h) => ({ l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 });
const hit = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

test("hub: the story only uses known nodes, ends with a person's answer, and has an approval step", () => {
  for (const s of STEPS) {
    assert.ok(NODES[s.by], s.by);
    if (s.to) assert.ok(NODES[s.to], s.to);
    assert.ok(["work", "handoff", "signal", "decision"].includes(s.k), s.k);
    assert.ok(s.text.length > 0 && s.text.length < 60, s.text);
  }
  assert.equal(STEPS.filter(s => s.ask).length, 1);
  assert.ok(Object.values(NODES).some(n => n.human), "a human node exists");
  assert.ok(!STEPS.some(s => NODES[s.by].human), "the person answers inside the approval step, not as an agent step");
});

test("hub: every node has a real logo file, or is the person", () => {
  for (const [id, n] of Object.entries(NODES)) {
    if (n.human) continue;
    assert.ok(existsSync(new URL("../public" + n.logo, import.meta.url)), id + " " + n.logo);
  }
});

test("hub: both layouts place every node, join each line to the log edge, and keep boxes apart", () => {
  for (const [name, L] of Object.entries(LAYOUTS)) {
    const ledger = { l: L.ledger.x, r: L.ledger.x + L.ledger.w, t: L.ledger.y, b: L.ledger.y + L.ledger.h };
    assert.ok(ledger.l >= 0 && ledger.r <= L.w && ledger.t >= 0 && ledger.b <= L.h, name + " ledger inside canvas");
    const boxes = [];
    for (const id of Object.keys(NODES)) {
      assert.ok(L.pos[id] && L.anchor[id] && L.start[id], `${name} ${id}`);
      const bx = box(L.pos[id][0], L.pos[id][1], L.node.w, L.node.h);
      assert.ok(bx.l >= 0 && bx.r <= L.w && bx.t >= 0 && bx.b <= L.h, `${name} ${id} inside canvas`);
      assert.ok(!hit(bx, ledger), `${name} ${id} clear of the log`);
      for (const o of boxes) assert.ok(!hit(bx, o), `${name} ${id} clear of another node`);
      boxes.push(bx);
      const [ax, ay] = L.anchor[id];
      const onEdge = ax === ledger.l || ax === ledger.r || ay === ledger.t || ay === ledger.b;
      assert.ok(onEdge && ax >= ledger.l && ax <= ledger.r && ay >= ledger.t && ay <= ledger.b, `${name} ${id} anchor on the log edge`);
    }
  }
});

test("hub: the homepage How it works section holds the hub, and the old orbit art is gone", () => {
  const html = read("public/index.html");
  const section = html.slice(html.indexOf('id="network"'), html.indexOf("three-col", html.indexOf('id="network"')));
  assert.ok(section.includes("data-network-hub"));
  assert.ok(html.includes('href="/network-hub.css"') && html.includes('src="/network-hub.js"'));
  assert.ok(section.includes("<noscript>"), "no-script text");
  assert.doesNotMatch(html, /network-art|class="orbit|class="satellite/);
  const css = read("public/home.css");
  assert.doesNotMatch(css, /\n\s*\.(network-art|orbit|orbit-one|orbit-two|satellite|center-node)\s*\{/);
});

test("hub: motion respects the viewer, the demo is labelled, and colours come from tokens", () => {
  const js = read("public/network-hub.js"), css = read("public/network-hub.css");
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /document\.hidden/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /Demo data/);
  assert.match(js, /aria-pressed/);
  assert.doesNotMatch(css, /(?:^|[;{\s])(?:background|color|fill|stroke|border(?:-color)?):\s*#/m, "no hard-coded colours");
  assert.match(css, /prefers-reduced-motion:reduce/);
});
