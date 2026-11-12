import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The desktop rail has no More link, so the Knowledge page must offer the board.
test("app: the Knowledge page links to the fleet truth board", () => {
  const views = readFileSync("public/app/views.js", "utf8");
  const row = views.split("\n").find((l) => l.includes('href="#/recall">Search shared memory</a>'));
  assert.ok(row, "the Knowledge link row exists");
  assert.match(row, /href="#\/channels\/fleet-truth">Fleet truth<\/a>/);
});
