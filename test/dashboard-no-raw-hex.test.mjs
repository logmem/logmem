import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SPACE_PAGES, safeReturnTo, spacePath } from "../apps/dashboard/lib/server/routes.mjs";

const ROOT = join(import.meta.dirname, "..");

function walkTsx(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTsx(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("apps/dashboard workspace pages and shared UI primitives contain zero raw hex colors", () => {
  const files = [
    ...walkTsx(join(ROOT, "apps/dashboard/app/(workspace)")),
    ...walkTsx(join(ROOT, "apps/dashboard/components/ui")),
  ];
  assert.ok(files.length >= 20, `expected >= 20 workspace/ui files, found ${files.length}`);

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const matches = text.match(/#[0-9a-fA-F]{3,8}\b/g);
    if (matches) offenders.push({ file: file.replace(`${ROOT}/`, ""), matches });
  }
  assert.deepEqual(offenders, [], `raw hex colors found in workspace/UI files: ${JSON.stringify(offenders)}`);
});

test("SPACE_PAGES includes chat and safeReturnTo preserves /space/<id>/chat", () => {
  assert.ok(SPACE_PAGES.includes("chat"), "SPACE_PAGES must include 'chat'");
  assert.equal(spacePath("madez", "chat"), "/space/madez/chat");
  assert.equal(safeReturnTo("/space/madez/chat"), "/space/madez/chat");
});

test("NavRail uses Brief label, aria-current, and 5-tab mobile bar with More dialog", () => {
  const rail = readFileSync(
    join(ROOT, "apps/dashboard/app/(workspace)/space/[space]/components/nav-rail.tsx"),
    "utf8",
  );
  assert.match(rail, /label:\s*'Brief'/);
  assert.doesNotMatch(rail, /label:\s*'Today'/);
  assert.match(rail, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(rail, /grid-cols-5/);
  assert.match(rail, /id="mobile-more-sheet"/);
});
