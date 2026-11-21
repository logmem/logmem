// Phase 6.2 slice 5: the secrets loader (presence only) and the integrations endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { loadIntegrationSecrets, testIntegration, lastErrorKey } from "../src/http/integrations.mjs";
import { createWorkspace, setMembership } from "../src/http/workspaces.mjs";
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
const OWNER = "user_owner00000001";
const ADMIN = "user_admin00000001";
const MEMBER = "user_member0000001";
const VIEWER = "user_viewer0000001";
const STRANGER = "user_stranger000001";
const reqFor = (method, body, { intent = true } = {}) => ({
  method,
  url: `${ORIGIN}/api/integrations`,
  headers: { origin: ORIGIN, host: "t.local", ...(intent ? { "x-logmem-intent": "integrations" } : {}) },
  body,
});
const resFor = () => ({ _h: {}, setHeader(k, v) { this._h[k] = v; }, status(c) { this.c = c; return this; }, json(j) { this.body = j; return this; } });
const handlerFor = (redis, userId, extra = {}) =>
  createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1", RESEND_API_KEY: PLANTED, RESEND_FROM_EMAIL: "bot@logmem.si" }, redis, session: async () => ({ status: "signed-in", userId }), ...extra });

async function ownerWorkspace(extra = {}) {
  const redis = createMemoryRedis();
  const created = await createWorkspace(
    { userId: OWNER, name: "Biz", firstSpaceName: "Ops", requestId: "req-int-owner" },
    { redis }
  );
  await setMembership({ actorId: OWNER, workspaceId: created.workspace.id, userId: ADMIN, role: "admin", spaces: {}, requestId: "req-int-admin" }, { redis });
  await setMembership({ actorId: OWNER, workspaceId: created.workspace.id, userId: MEMBER, role: "member", spaces: {}, requestId: "req-int-member" }, { redis });
  await setMembership({
    actorId: OWNER,
    workspaceId: created.workspace.id,
    userId: VIEWER,
    role: "viewer",
    spaces: { [created.space.id]: { role: "viewer", canApprove: false } },
    requestId: "req-int-viewer",
  }, { redis });
  return { redis, handler: handlerFor(redis, OWNER, extra), ...created };
}

test("GET returns the list with last errors and no secret", async () => {
  const { redis, handler } = await ownerWorkspace();
  await redis("SET", lastErrorKey("email"), JSON.stringify({ error: "credential_rejected", at: 1795000000000 }));
  const res = resFor();
  await handler(reqFor("GET"), res);
  assert.equal(res.c, 200);
  assert.equal(res.body.ok, true);
  const email = res.body.data.integrations.find((i) => i.id === "email");
  assert.equal(email.configured, true);
  assert.equal(email.lastError.error, "credential_rejected");
  assert.equal(JSON.stringify(res.body).includes(PLANTED), false, "response never contains the key");
});

test("POST test needs intent, a known id and a real action", async () => {
  const { handler: h } = await ownerWorkspace({ fetchImpl: async () => ({ ok: true }) });

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
  const { redis, handler } = await ownerWorkspace();
  const out = resFor();
  await createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1" }, redis, session: async () => ({ status: "signed-out" }) })(reqFor("GET"), out);
  assert.equal(out.c, 401);

  const put = resFor();
  await handler(reqFor("PUT"), put);
  assert.equal(put.c, 405);
});

test("a missing session is 401 and a session without the manager role is 403", async () => {
  const { redis } = await ownerWorkspace();
  const calls = [];
  const fetchImpl = async () => {
    calls.push("fetch");
    return { ok: true };
  };
  const deny = async (userId, method, body) => {
    const res = resFor();
    const session = userId ? async () => ({ status: "signed-in", userId }) : async () => ({ status: "signed-out" });
    await createHandler({
      env: { LOGMEM_CUSTOMER_DASHBOARD: "1", RESEND_API_KEY: PLANTED, RESEND_FROM_EMAIL: "bot@logmem.si" },
      redis,
      session,
      fetchImpl,
    })(reqFor(method, body), res);
    return res;
  };

  const signedOut = await deny(null, "GET");
  assert.equal(signedOut.c, 401);
  assert.deepEqual(signedOut.body, { error: "sign_in_required" });

  for (const userId of [MEMBER, VIEWER, STRANGER]) {
    const listed = await deny(userId, "GET");
    assert.equal(listed.c, 403, `${userId} must not list integrations`);
    assert.deepEqual(listed.body, { error: "forbidden" });
    assert.equal(JSON.stringify(listed.body).includes(PLANTED), false);

    const posted = await deny(userId, "POST", { action: "test", id: "email" });
    assert.equal(posted.c, 403, `${userId} must not run a live test`);
    assert.deepEqual(posted.body, { error: "forbidden" });
  }
  assert.equal(calls.length, 0, "a denied session never reaches the upstream test");

  const admin = resFor();
  await handlerFor(redis, ADMIN)(reqFor("GET"), admin);
  assert.equal(admin.c, 200);
  assert.equal(admin.body.ok, true);
});

test("POST uses the parsed body and rejects malformed or unexpected input", async () => {
  const calls = [];
  const { handler } = await ownerWorkspace({
    fetchImpl: async () => {
      calls.push("fetch");
      return { ok: true };
    },
  });
  const post = async (body) => {
    const res = resFor();
    await handler(reqFor("POST", body), res);
    return res;
  };

  const parsed = await post(JSON.stringify({ action: "test", id: "email" }));
  assert.equal(parsed.c, 200, "a JSON string is parsed before the action runs");
  assert.deepEqual(parsed.body, { ok: true, status: "ok", error: null });

  const extra = await post({ action: "test", id: "email", surprise: true });
  assert.equal(extra.c, 400);
  assert.deepEqual(extra.body, { error: "invalid_action" });

  const malformed = await post("{not json");
  assert.equal(malformed.c, 400);
  assert.deepEqual(malformed.body, { error: "invalid_json" });

  const arrayBody = await post([{ action: "test", id: "email" }]);
  assert.equal(arrayBody.c, 400);
  assert.deepEqual(arrayBody.body, { error: "invalid_json" });

  const empty = await post(null);
  assert.equal(empty.c, 400);
  assert.deepEqual(empty.body, { error: "invalid_json" });

  const oversized = await post({ action: "test", id: "x".repeat(17000) });
  assert.equal(oversized.c, 413);
  assert.deepEqual(oversized.body, { error: "request_too_large" });

  assert.equal(calls.length, 1, "only the parsed valid body reaches the live test");
});
