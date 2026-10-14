// test/keymaster-request.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, parseTtl, MAX_TTL_SECONDS } from "../cloud/keymaster/request.mjs";

test("request: a good request parses", () => {
  const r = parseRequest({ secret: "/shared/openai/OPENAI_API_KEY", for: "agent-codex", scope: "read", ttl: "30d" });
  assert.deepEqual(r, { ok: true, req: { secret_ref: "/shared/openai/OPENAI_API_KEY", path: "/shared/openai", name: "OPENAI_API_KEY", agent: "codex", identity: "agent-codex", scope: "read", ttlSeconds: 30 * 86400, sensitive: false } });
});

test("request: bridge and payment refs are sensitive", () => {
  assert.equal(parseRequest({ secret: "/fleet-shared/acmi/ACMI_BRIDGE_TOKEN", for: "agent-codex", ttl: "1d" }).req.sensitive, true);
  assert.equal(parseRequest({ secret: "/shared/stripe/STRIPE_SECRET_KEY", for: "agent-codex", ttl: "1d" }).req.sensitive, true);
});

test("request: refuses no ttl, too long a ttl, the keymaster itself, and bad paths", () => {
  for (const bad of [
    { secret: "/shared/openai/K", for: "agent-codex" },
    { secret: "/shared/openai/K", for: "agent-codex", ttl: "365d" },
    { secret: "/shared/openai/K", for: "agent-keymaster", ttl: "1d" },
    { secret: "../etc/K", for: "agent-codex", ttl: "1d" },
    { secret: "/shared/openai/K", for: "agent-codex", ttl: "1d", scope: "write" },
  ]) assert.equal(parseRequest(bad).ok, false, JSON.stringify(bad));
});

test("ttl: units", () => {
  assert.equal(parseTtl("90m"), 5400);
  assert.equal(parseTtl("12h"), 43200);
  assert.equal(parseTtl("bogus"), null);
  assert.ok(MAX_TTL_SECONDS === 90 * 86400);
});
