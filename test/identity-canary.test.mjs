// test/identity-canary.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCanary } from "../scripts/identity-canary.mjs";

const inf = (over = {}) => ({ login: async () => ({ ok: true, token: "t" }), getSecretLength: async ({ path, name }) => (path === "/agents/codex" && name === "CANARY" ? { ok: true, length: 12 } : { ok: false, error: "404" }), ...over });

test("canary: ok with length only", async () => {
  assert.deepEqual(await runCanary({ agent: "codex", clientId: "c", clientSecret: "s", inf: inf() }), { agent: "codex", ok: true, length: 12 });
});

test("canary: login failure is reported, not thrown", async () => {
  const r = await runCanary({ agent: "codex", clientId: "c", clientSecret: "s", inf: inf({ login: async () => ({ ok: false, error: "infisical POST /x returned 401" }) }) });
  assert.deepEqual(r, { agent: "codex", ok: false, error: "infisical POST /x returned 401" });
});

test("canary: rejects a bad agent id before any call", async () => {
  const r = await runCanary({ agent: "../etc", clientId: "c", clientSecret: "s", inf: inf({ login: async () => assert.fail("no call") }) });
  assert.equal(r.ok, false);
});
