// Connected apps for managed accounts (one-click connect plan, task 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, registerClient, mintTokens, lookupAccessToken, listManagedApps, revokeManagedApp, touchManagedAppCall } from "../api/oauth/_lib/storage.mjs";
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

test("connections: token expiry leaves token-free app metadata available to disconnect", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      await connect(ada, "muse");
      const app = (await listManagedApps(ada.tenant))[0];
      const metadataKey = `lm:account:app:${app.fid}`;
      assert.equal(await redis("TTL", metadataKey), -1, "app metadata must not expire with refresh tokens");
      await redis("SADD", `lm:${ada.space}:agents`, "muse");
      // Remove token records to represent expiry. Metadata remains disconnectable.
      for (const key of [...redis.data.keys()]) if (/^lm:oauth:(at|rt|fam):/.test(key)) await redis("DEL", key);
      const result = await call(handler(redis, ADA), { method: "POST", body: { action: "disconnect", fid: app.fid }, headers: { "x-logmem-intent": "connections" } });
      assert.deepEqual(result.body, { disconnected: true });
      assert.equal(await redis("SISMEMBER", `lm:${ada.space}:agents`, "muse"), 0);
    } finally { __setRedisForTests(null); }
  });
});

test("connections: failed customer cleanup keeps a revocable app for retry", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      const token = await connect(ada, "muse");
      const app = (await listManagedApps(ada.tenant))[0];
      const agents = `lm:${ada.space}:agents`;
      await redis("SADD", agents, "muse");
      let fail = true;
      const flaky = async (...args) => {
        if (fail && args[0] === "SREM" && args[1] === agents) {
          fail = false;
          throw new Error("customer cleanup unavailable");
        }
        return redis(...args);
      };
      const h = handler(flaky, ADA);
      const request = { method: "POST", body: { action: "disconnect", fid: app.fid }, headers: { "x-logmem-intent": "connections" } };
      assert.equal((await call(h, request)).status, 500);
      assert.equal(await lookupAccessToken(token.access_token), null);
      assert.equal((await listManagedApps(ada.tenant)).length, 1);
      assert.deepEqual((await call(h, request)).body, { disconnected: true });
      assert.equal(await redis("SISMEMBER", agents, "muse"), 0);
      assert.equal((await listManagedApps(ada.tenant)).length, 0);
    } finally { __setRedisForTests(null); }
  });
});

test("connections: simultaneous disconnects release a shared agent once both apps revoke", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      await connect(ada, "muse");
      await connect(ada, "muse");
      await redis("SADD", `lm:${ada.space}:agents`, "muse");
      const apps = await listManagedApps(ada.tenant);
      const h = handler(redis, ADA);
      const results = await Promise.all(apps.map((app) => call(h, { method: "POST", body: { action: "disconnect", fid: app.fid }, headers: { "x-logmem-intent": "connections" } })));
      assert.ok(results.every((r) => r.body.disconnected));
      assert.equal(await redis("SISMEMBER", `lm:${ada.space}:agents`, "muse"), 0);
    } finally { __setRedisForTests(null); }
  });
});

test("connections: failed token revocation keeps the app active for shared-slot cleanup", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      const live = await connect(ada, "muse");
      await connect(ada, "muse");
      const apps = await listManagedApps(ada.tenant);
      const liveFid = (await lookupAccessToken(live.access_token)).fid;
      const failedApp = apps.find((a) => a.fid === liveFid);
      const otherApp = apps.find((a) => a.fid !== liveFid);
      const agents = `lm:${ada.space}:agents`;
      await redis("SADD", agents, "muse");
      let fail = true;
      __setRedisForTests(async (...args) => {
        if (fail && args[0] === "SET" && args[1] === `lm:oauth:fam:${failedApp.fid}:revoked`) {
          fail = false;
          throw new Error("revocation unavailable");
        }
        return redis(...args);
      });
      const h = handler(redis, ADA);
      const disconnect = (fid) => call(h, { method: "POST", body: { action: "disconnect", fid }, headers: { "x-logmem-intent": "connections" } });
      assert.equal((await disconnect(failedApp.fid)).status, 500);
      assert.ok(await lookupAccessToken(live.access_token), "the failed revocation leaves its token live");
      assert.equal((await listManagedApps(ada.tenant)).find((a) => a.fid === failedApp.fid).disconnected, undefined);
      assert.deepEqual((await disconnect(otherApp.fid)).body, { disconnected: true });
      assert.equal(await redis("SISMEMBER", agents, "muse"), 1, "a live app still owns the slot");
      assert.deepEqual((await disconnect(failedApp.fid)).body, { disconnected: true });
      assert.equal(await redis("SISMEMBER", agents, "muse"), 0);
    } finally { __setRedisForTests(null); }
  });
});

test("connections: a tool call records when the app last called and which agent it used, once a minute", async () => {
  await withEnv(ENV, async () => {
    try {
      const { ada, connect } = await setup();
      await connect(ada, "muse");
      const [app] = await listManagedApps(ada.tenant);
      assert.equal(app.last_call_at, undefined, "a new app has not called yet");
      assert.equal(await touchManagedAppCall(app.fid, { agent: "muse" }), true);
      assert.equal(await touchManagedAppCall(app.fid, { agent: "other" }), false, "a second call inside a minute does not write");
      const [after] = await listManagedApps(ada.tenant);
      assert.ok(after.last_call_at > 0);
      assert.equal(after.last_call_agent, "muse");
      assert.equal(await touchManagedAppCall("not-a-grant", { agent: "x" }), false);
      assert.equal(await touchManagedAppCall("0".repeat(32), { agent: "x" }), false, "no record, no write");
    } finally {
      __setRedisForTests(null);
    }
  });
});

test("connections: the owner's list carries last_call_at and last_call_agent, and no token", async () => {
  await withEnv(ENV, async () => {
    try {
      const { redis, ada, connect } = await setup();
      const t = await connect(ada, "muse");
      const [app] = await listManagedApps(ada.tenant);
      await touchManagedAppCall(app.fid, { agent: "muse" });
      const r = await call(handler(redis, ADA));
      assert.equal(r.status, 200);
      assert.ok(r.body.apps[0].last_call_at > 0);
      assert.equal(r.body.apps[0].last_call_agent, "muse");
      assert.ok(!JSON.stringify(r.body).includes(t.access_token));
    } finally {
      __setRedisForTests(null);
    }
  });
});
