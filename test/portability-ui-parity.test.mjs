import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as vanilla from "../public/app/portability-model.js";
import * as dashboard from "../apps/dashboard/lib/portability-model.mjs";

test("portability UI parity: vanilla and Next.js dashboard models stay identical", () => {
  assert.deepEqual(vanilla.ROLE_PRESETS, dashboard.ROLE_PRESETS);
  assert.deepEqual(vanilla.RBAC_CHEATSHEET, dashboard.RBAC_CHEATSHEET);
  assert.deepEqual(vanilla.BUNDLE_MODES, dashboard.BUNDLE_MODES);
  assert.deepEqual(vanilla.SECURITY_GUARANTEES, dashboard.SECURITY_GUARANTEES);

  // Owner sees Client Approver; non-owner admin does not
  assert.equal(vanilla.visiblePresets({ isOwner: true }).some((p) => p.id === "client_approver"), true);
  assert.equal(vanilla.visiblePresets({ isOwner: false }).some((p) => p.id === "client_approver"), false);
  assert.deepEqual(vanilla.visiblePresets({ isOwner: true }), dashboard.visiblePresets({ isOwner: true }));
  assert.deepEqual(vanilla.visiblePresets({ isOwner: false }), dashboard.visiblePresets({ isOwner: false }));

  const d = new Date("2026-11-26T12:00:00Z");
  assert.equal(
    vanilla.buildBundleFilename("Silver Keys!", "blueprint", true, d),
    "silver-keys-blueprint-2026-11-26.logmem.json.gz"
  );
  assert.equal(
    vanilla.buildBundleFilename("Silver Keys!", "blueprint", true, d),
    dashboard.buildBundleFilename("Silver Keys!", "blueprint", true, d)
  );
  assert.equal(vanilla.formatBytes(512), "512 B");
  assert.equal(vanilla.formatBytes(2048), "2 KB");
  assert.equal(vanilla.formatBytes(3_831_000), dashboard.formatBytes(3_831_000));
  assert.equal(vanilla.shortHash("068373d142f8b41e", 12), "068373d142f8");
});

test("portability UI guardrails: zero raw #hex and zero /app link leaks in new dashboard components", () => {
  const files = [
    "apps/dashboard/app/(workspace)/space/[space]/components/settings-view.tsx",
    "apps/dashboard/app/(workspace)/space/[space]/components/import-banner.tsx",
    "apps/dashboard/app/(workspace)/space/[space]/components/nav-rail.tsx",
    "apps/dashboard/app/(workspace)/select-space/select-space-client.tsx",
    "apps/dashboard/app/(workspace)/select-space/page.tsx",
    "apps/dashboard/app/(workspace)/space/[space]/settings/page.tsx",
  ];
  for (const rel of files) {
    const src = readFileSync(rel, "utf8");
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(src), false, `${rel} must use CSS vars, never raw #hex`);
    assert.equal(/href=["']\/app\b/.test(src), false, `${rel} must not link to /app`);
  }
});
