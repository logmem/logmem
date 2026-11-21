// Phase 6.2 slice 5: the secrets loader (presence only) and the integrations endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { loadIntegrationSecrets, testIntegration, lastErrorKey } from "../src/http/integrations.mjs";
import { createHandler } from "../api/integrations.mjs";

const PLANTED = "sk-super-secret-value-do-not-leak";

test("the loader reports presence only and never emits a secret value", () => {
  const env = { RESEND_API_KEY: PLANTED, RESEND_FROM_EMAIL: "bot@logmem.si", CLERK_SECRET_KEY: "cs", CLERK_PUBLISHABLE_KEY: "pk" };
  const rows = loadIntegrationSecrets(env);
  const email = rows.find((r) => r.id === "email");
  const auth = rows.find((r) => r.id === "auth");
  assert.equal(email.configured, true);
  assert.equal(email.testable, true);
  assert.equal(auth.configured, true);
  assert.deepEqual(email.keys.map((k) => k.name), ["RESEND_API_KEY", "RESEND_FROM_EMAIL"]);
  assert.equal(JSON.stringify(rows).includes(PLANTED), false, "no secret value anywhere in the output");
  assert.equal(JSON.stringify(rows).includes("sk-super"), false, "not even a prefix");

  const partial = loadIntegrationSecrets({ CLERK_SECRET_KEY: "cs" });
  assert.equal(partial.find((r) => r.id === "auth").configured, false, "publishable key missing means not configured");
  assert.equal(partial.find((r) => r.id === "email").configured, false);
});

test("live test records failures and clears them on success", async () => {
  const redis = createMemoryRedis();
  const env = { RESEND_API_KEY: "rk", RESEND_FROM_EMAIL: "a@b.c" };

  const rejected = await testIntegration("email", { env, redis, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(rejected, { ok: false, error: "credential_rejected" });
  const stored = JSON.parse(await redis("GET", lastErrorKey("email")));
  assert.equal(stored.error, "credential_rejected");
  assert.ok(Number.isFinite(stored.at));

  const down = await testIntegration("email", { env, redis, fetchImpl: async () => { throw new Error("net down"); } });
  assert.equal(down.error, "unreachable");

  const good = await testIntegration("email", { env, redis, fetchImpl: async () => ({ ok: true }) });
  assert.equal(good.ok, true);
  assert.equal(await redis("GET", lastErrorKey("email")), null, "success clears the last error");

  const upstream = await testIntegration("email", { env, redis, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(upstream.error, "upstream_500");

  assert.deepEqual(await testIntegration("nope", { env, redis }), { ok: false, error: "unknown_integration" });
  assert.deepEqual(await testIntegration("auth", { env, redis }), { ok: false, error: "not_testable" });
  assert.deepEqual(await testIntegration("email", { env: {}, redis, fetchImpl: async () => ({ ok: true }) }), { ok: false, error: "not_configured" });
});

const ORIGIN = "http://t.local";
const reqFor = (method, body, { intent = true } = {}) => ({
  method,
  url: `${ORIGIN}/api/integrations`,
  headers: { origin: ORIGIN, ...(intent ? { "x-logmem-intent": "integrations" } : {}) },
  body,
});
const resFor = () => ({ _h: {}, setHeader(k, v) { this._h[k] = v; }, status(c) { this.c = c; return this; }, json(j) { this.body = j; return this; } });
const handlerWith = (redis, extra = {}) =>
  createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1", RESEND_API_KEY: PLANTED, RESEND_FROM_EMAIL: "bot@logmem.si" }, redis, session: async () => ({ status: "signed-in", userId: "user_x" }), ...extra });

test("GET returns the list with last errors and no secret", async () => {
  const redis = createMemoryRedis();
  await redis("SET", lastErrorKey("email"), JSON.stringify({ error: "credential_rejected", at: 1795000000000 }));
  const res = resFor();
  await handlerWith(redis)(reqFor("GET"), res);
  assert.equal(res.c, 200);
  assert.equal(res.body.ok, true);
  const email = res.body.data.integrations.find((i) => i.id === "email");
  assert.equal(email.configured, true);
  assert.equal(email.lastError.error, "credential_rejected");
  assert.equal(JSON.stringify(res.body).includes(PLANTED), false, "response never contains the key");
});

test("POST test needs intent, a known id and a real action", async () => {
  const redis = createMemoryRedis();
  const h = handlerWith(redis, { fetchImpl: async () => ({ ok: true }) });

  const noIntent = resFor();
  await h(reqFor("POST", { action: "test", id: "email" }, { intent: false }), noIntent);
  assert.equal(noIntent.c, 403);

  const badAction = resFor();
  await h(reqFor("POST", { action: "nuke", id: "email" }), badAction);
  assert.equal(badAction.c, 400);

  const unknown = resFor();
  await h(reqFor("POST", { action: "test", id: "telegram" }), unknown);
  assert.equal(unknown.c, 404);

  const ok = resFor();
  await h(reqFor("POST", { action: "test", id: "email" }), ok);
  assert.equal(ok.c, 200);
  assert.deepEqual(ok.body, { ok: true, status: "ok", error: null });
});

test("signed out is401 and non-GET-non-POST is405", async () => {
  const redis = createMemoryRedis();
  const out = resFor();
  await createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1" }, redis, session: async () => ({ status: "signed-out" }) })(reqFor("GET"), out);
  assert.equal(out.c, 401);

  const put = resFor();
  await handlerWith(redis)(reqFor("PUT"), put);
  assert.equal(put.c, 405);
});
