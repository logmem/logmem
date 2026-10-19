// Connected apps for managed accounts (one-click connect plan, task 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, registerClient, mintTokens, lookupAccessToken, listManagedApps, revokeManagedApp } from "../api/oauth/_lib/storage.mjs";
import { inviteMany } from "../src/http/invites.mjs";
import { accountFor } from "../src/http/accounts.mjs";
import { createHandler } from "../api/connections.mjs";

const ENV = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };
const ADA = { userId: "user_2adaADA123ghiJKL", email: "ada+clerk_test@example.com" };
const BOB = { userId: "user_2bobBOB123ghiJKL", email: "bob+clerk_test@example.com" };

async function setup() {
  const redis = oauthRedis();
  __setRedisForTests(redis);
  await inviteMany([ADA.email, BOB.email], { redis });
  const ada = await accountFor({ clerkUserId: ADA.userId, email: ADA.email }, { redis, env: {} });
  const bob = await accountFor({ clerkUserId: BOB.userId, email: BOB.email }, { redis, env: {} });
  const client = await registerClient({ client_name: "Muse", redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
  const connect = (acct, agent) => mintTokens({ client_id: client.client_id, scope: "mcp", upstash_url: null, upstash_token: null, backend: { kind: "managed", tenant: acct.tenant, agent }, sub: "clerk:x", space: acct.space });
  return { redis, ada, bob, client, connect };
}

const handler = (redis, who) => createHandler(() => ({
  ready: () => true,
  session: async () => (who ? { status: "signed-in", ...who } : { status: "signed-out", signInUrl: "https://happy-cat-12.accounts.dev/sign-in?redirect_url=x" }),
  redis: () => redis,
  waitlistRedis: () => createMemoryRedis(),
}));

async function call(h, { method = "GET", url = "/api/connections", body, headers = {} } = {}) {
  const req = mockReq({ method, url, body, headers: { host: "logmem.si", ...headers } });
  const res = mockRes();
  await h(req, res);
  let json;
  try { json = res.body ? JSON.parse(res.body) : undefined; } catch { json = undefined; }
  return { status: res.statusCode, body: json, headers: res.headers, res };
}

test("connections: a managed grant is recorded once, refreshes update last use, nothing secret is stored", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      const t = await connect(ada, "muse");
      const apps = await listManagedApps(ada.tenant);
      assert.equal(apps.length, 1);
      assert.equal(apps[0].app ?? apps[0].client_name, "Muse");
      assert.equal(apps[0].agent, "muse");
      const rec = JSON.stringify([...redis.data.entries()].filter(([k]) => k.startsWith("lm:account:app")));
      assert.ok(!rec.includes(t.access_token) && !rec.includes(t.refresh_token), "no tokens in the app record");
      await mintTokens({ client_id: apps[0].client_id, scope: "mcp", backend: { kind: "managed", tenant: ada.tenant, agent: "muse" }, sub: "clerk:x", space: ada.space, fid: apps[0].fid });
      assert.equal((await listManagedApps(ada.tenant)).length, 1, "a refresh does not add a second app");
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("connections: signed out gets a sign-in link; signin=1 goes to Clerk and back", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis } = await setup();
      const out = await call(handler(redis, null));
      assert.equal(out.status, 401);
      assert.equal(out.body.signin, "/api/connections?signin=1");
      const go = await call(handler(redis, null), { url: "/api/connections?signin=1" });
      assert.equal(go.status, 302);
      assert.match(String(go.res.getHeader("location")), /accounts\.dev\/sign-in/);
      const back = await call(handler(redis, ADA), { url: "/api/connections?signin=1" });
      assert.equal(String(back.res.getHeader("location")), "/connections");
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("connections: each owner sees only their own apps", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, bob, connect } = await setup();
      await connect(ada, "muse");
      await connect(bob, "muse");
      await connect(bob, "claude");
      const a = await call(handler(redis, ADA));
      assert.equal(a.status, 200);
      assert.equal(a.body.apps.length, 1);
      assert.equal(a.body.space, ada.space);
      assert.equal((await call(handler(redis, BOB))).body.apps.length, 2);
      assert.ok(!JSON.stringify(a.body).includes("access_token"));
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("connections: disconnect revokes the tokens, frees the agent slot, and only works on your own apps", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, bob, connect } = await setup();
      const t = await connect(ada, "muse");
      await redis("SADD", `lm:${ada.space}:agents`, "muse");
      const bobTok = await connect(bob, "muse");
      const adaFid = (await listManagedApps(ada.tenant))[0].fid;
      const bobFid = (await listManagedApps(bob.tenant))[0].fid;
      const h = handler(redis, ADA);
      const w = { "x-logmem-intent": "connections", origin: "https://logmem.si" };
      assert.equal((await call(h, { method: "POST", body: { action: "disconnect", fid: adaFid } })).status, 403, "intent header required");
      assert.equal((await call(h, { method: "POST", body: { action: "disconnect", fid: adaFid }, headers: { ...w, origin: "https://evil.example" } })).status, 403, "cross-site refused");
      assert.deepEqual((await call(h, { method: "POST", body: { action: "disconnect", fid: bobFid }, headers: w })).body, { disconnected: false }, "someone else's app");
      assert.ok(await lookupAccessToken(bobTok.access_token), "bob's token still works");
      assert.deepEqual((await call(h, { method: "POST", body: { action: "disconnect", fid: adaFid }, headers: w })).body, { disconnected: true });
      assert.equal(await lookupAccessToken(t.access_token), null, "ada's token is revoked");
      assert.equal(Number(await redis("SISMEMBER", `lm:${ada.space}:agents`, "muse")), 0, "the agent slot is free");
      assert.equal((await call(h)).body.apps.length, 0);
      // A late refresh of the revoked grant must not bring the app back.
      await mintTokens({ client_id: "x", scope: "mcp", backend: { kind: "managed", tenant: ada.tenant, agent: "muse" }, sub: "clerk:x", space: ada.space, fid: adaFid });
      assert.equal((await listManagedApps(ada.tenant)).length, 0);
      assert.equal(await revokeManagedApp(ada.tenant, "not-a-fid"), null);
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("connections: no customer Redis is a 503", async () => {
  const h = createHandler(() => ({ ready: () => true, session: async () => ({ status: "signed-out" }), redis: () => { throw new Error("none"); } }));
  assert.equal((await call(h)).status, 503);
});
