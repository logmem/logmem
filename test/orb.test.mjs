import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hexToRgb, resolveVariant, defaultVariant, fallbackFaceStyle, WEBGL_COLORS, TEAL_LIGHT, TEAL_DARK } from "../public/orb.js";

test("orb: hex parsing handles short, long and bad input", () => {
  assert.deepEqual(hexToRgb("#fff"), [1, 1, 1]);
  assert.deepEqual(hexToRgb("#000000"), [0, 0, 0]);
  assert.equal(hexToRgb("#zzzzzz").length, 3);
});

test("orb: an omitted variant follows the theme", () => {
  assert.equal(defaultVariant(true), "white");
  assert.equal(defaultVariant(false), "black");
  assert.equal(resolveVariant(undefined, undefined, undefined, undefined, true).mode, 0);
});

test("orb: custom uses the colors given and the webgl preset uses a palette", () => {
  const c = resolveVariant("custom", TEAL_LIGHT.color, TEAL_LIGHT.eyeColor);
  assert.equal(c.body, TEAL_LIGHT.color);
  assert.notEqual(TEAL_LIGHT.color, TEAL_DARK.color);
  const w = resolveVariant("webgl");
  assert.equal(w.mode, 1);
  assert.deepEqual(w.palette, WEBGL_COLORS);
  assert.match(fallbackFaceStyle(w).backgroundImage, /^linear-gradient/);
  assert.equal(fallbackFaceStyle(c).backgroundColor, TEAL_LIGHT.color);
});

test("orb: onboarding loads the module from its own origin and the host is decorative", () => {
  const html = readFileSync(new URL("../public/onboarding.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../public/onboarding.js", import.meta.url), "utf8");
  assert.match(html, /id="ob-orb" aria-hidden="true"/);
  assert.match(js, /import\('\/orb\.js'\)/);
});
