// test/secrets-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecret, assertNoSecret, SECRET_REFUSED } from "../src/core/secrets-guard.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const fakes = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  stripe: "sk_live_" + "51Habcdefghijklmnopqrstuv",
  github: "ghp_" + "a".repeat(36),
  slack: "xoxb-" + "1234567890-abcdefghijkl",
  pem: "-----BEGIN " + "PRIVATE KEY-----",
  bearer: "Bearer " + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  assign: "API_KEY=" + "Zx9" + "q".repeat(28),
  dbpass: "DB_PASSWORD: \"" + "a8Fk2pQz9LmN3xRt7vWy" + "\"",
  hex: "TOKEN=" + "0123456789abcdef".repeat(2),
};

test("guard: refuses each fake key shape", () => {
  for (const [name, v] of Object.entries(fakes)) assert.ok(findSecret(v), name);
});

test("guard: refuses a key inside prose", () => {
  assert.ok(findSecret(`set the key to ${fakes.stripe} then redeploy`));
});

test("guard: allows trails and hashes", () => {
  for (const ok of ["handoffIssue14-1791988665997-0425b8b35e8b16fbd334f90b", "commit 98698cb", "sha256 3294043fd6407f895457038acb561c56fed1ed751988e2d855ea9305562425d5", "/fleet-shared/acmi ACMI_BRIDGE_TOKEN length 64", "OPENAI_API_KEY: /shared/openai/OPENAI_API_KEY", "ACMI_BRIDGE_TOKEN=/fleet-shared/acmi/ACMI_BRIDGE_TOKEN", "CRON_SECRET=see-infisical-fleet-secrets-prod"])
    assert.equal(findSecret(ok), null, ok);
});

test("guard: assertNoSecret walks objects and names the field", () => {
  assert.throws(() => assertNoSecret("payload", { a: [{ b: fakes.github }] }), (e) => e.message.startsWith(SECRET_REFUSED) && e.message.includes("payload"));
  assert.doesNotThrow(() => assertNoSecret("payload", { ref: "/shared/openai/OPENAI_API_KEY" }));
});

test("guard: a LogMem write with a key is refused and nothing is stored", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "fieldnotes", surface: "codex", sessionId: "s1" });
  await lm.callTool("logmem_start", { agent: "atlas" });
  const r = (await lm.callTool("logmem_note", { where: "channel:ops", summary: `key is ${fakes.aws}` })).structuredContent;
  assert.equal(r.ok, false);
  assert.match(r.error, /secret/i);
  const v = (await lm.callTool("logmem_view", { ref: "channel:ops" })).structuredContent;
  assert.ok(!JSON.stringify(v).includes(fakes.aws));
});
