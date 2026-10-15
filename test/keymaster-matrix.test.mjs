// test/keymaster-matrix.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix, publishMatrix } from "../cloud/keymaster/matrix.mjs";
import { createStore } from "../src/core/store.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

const NOW = Date.parse("2026-10-15T00:00:00Z"), DAY = 86400000;
const grants = [
  { identity: "agent-codex", identityId: "i1", path: "/shared/openai", scope: "read", expiresAt: NOW + 30 * DAY, grantId: "g1" },
  { identity: "agent-opencode", identityId: "i2", path: "/shared/stripe", scope: "read", expiresAt: NOW + 3 * DAY, grantId: "g2" },
  { identity: "agent-claude-code", identityId: "i3", path: "/agents/claude-code", scope: "read", expiresAt: null, grantId: "g3" },
];

test("matrix: rows carry refs and dates only; near-expiry rows are stale", () => {
  const m = buildMatrix(grants, NOW);
  assert.equal(m.rows.length, 3);
  assert.deepEqual(m.rows[0], { agent: "claude-code", identity: "agent-claude-code", path: "/agents/claude-code", scope: "read", expires_at: null, days_left: null });
  assert.deepEqual(m.stale.map((r) => r.agent), ["opencode"]);
});

test("matrix: publish writes Now on job:secrets and one alert per stale row", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" });
  await publishMatrix(store, grants, { now: NOW });
  const now = await store.getNow("job", "secrets");
  assert.equal(now.matrix.length, 3);
  assert.equal(now.stale_count, 1);
  const log = await store.readLog("job", "secrets");
  assert.equal(log.filter((e) => e.kind === "alert").length, 1);
  assert.ok(!JSON.stringify({ now, log }).match(/grantId|identityId/));
});
