import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setRedisForTests, registerClient, saveAuthCode, sha256base64url } from "../api/oauth/_lib/storage.mjs";
import registerHandler, { validateRegistration } from "../api/oauth/register.mjs";
import authorizeHandler from "../api/oauth/authorize.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, consentSession, TEST_KEK_HEX } from "./oauth-helpers.mjs";

const AUTH_KEYS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"];
/** POST `body` the way the real consent page would: GET it first for cookie + csrf_token. */
async function consentPost(res, body, { tamper } = {}) {
  const q = Object.fromEntries(AUTH_KEYS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const { cookie, csrf_token } = await consentSession(authorizeHandler, q);
  const b = { ...body, csrf_token, ...(tamper || {}) };
  await authorizeHandler(mockReq({ method: "POST", url: "/api/oauth/authorize", body: b, headers: { cookie } }), res);
}

afterEach(() => __setRedisForTests(null));

// ───── register ─────

test("register: validation bounds", () => {
  const ok = (b) => assert.ok(validateRegistration(b).meta, JSON.stringify(b).slice(0, 80));
  const no = (b) => assert.ok(validateRegistration(b).error, JSON.stringify(b).slice(0, 80));
  ok({ redirect_uris: ["https://app.example/cb"] });
  ok({ redirect_uris: ["http://localhost:3000/cb", "http://127.0.0.1/cb"], client_name: "x".repeat(100), scope: "s".repeat(64), token_endpoint_auth_method: "client_secret_post" });
  no({});
  no({ redirect_uris: [] });
  no({ redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`) });
  no({ redirect_uris: [`https://a.example/${"p".repeat(2048)}`] });
  no({ redirect_uris: ["http://evil.example/cb"] });
  no({ redirect_uris: ["http://localhost.evil.example/cb"] });
  no({ redirect_uris: ["javascript:alert(1)"] });
  no({ redirect_uris: ["https://a.example/cb#frag"] });
  no({ redirect_uris: [42] });
  no({ redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(101) });
  no({ redirect_uris: ["https://a.example/cb"], client_name: { a: 1 } });
  no({ redirect_uris: ["https://a.example/cb"], scope: "s".repeat(65) });
  no({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" });
  no({ redirect_uris: ["https://a.example/cb"], grant_types: ["implicit"] });
  no({ redirect_uris: ["https://a.example/cb"], response_types: ["token"] });
});

test("register: handler returns 400 on bad body and 201 with a TTL'd record on good body", async () => {
  const r = oauthRedis();
  __setRedisForTests(r);
  const bad = mockRes();
  await registerHandler(mockReq({ method: "POST", body: { redirect_uris: ["http://evil.example/cb"] } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(r.data.size, 0);

  const good = mockRes();
  await registerHandler(mockReq({ method: "POST", body: { redirect_uris: ["https://app.example/cb"], client_name: "App" } }), good);
  assert.equal(good.statusCode, 201);
  const client = JSON.parse(good.body);
  assert.equal(r.ttls.get(`lm:oauth:client:${client.client_id}`), 30 * 24 * 3600);
});

// ───── authorize: open redirect ─────

const authQuery = (o) => "/api/oauth/authorize?" + new URLSearchParams({ response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "st", ...o });

test("authorize: unknown client or unregistered redirect_uri => 400 page, never a redirect", async () => {
  const r = oauthRedis();
  __setRedisForTests(r);
  const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });

  const cases = [
    { client_id: "cli_unknown", redirect_uri: "https://evil.example/steal" },
    { client_id: c.client_id, redirect_uri: "https://evil.example/steal" },
    { client_id: c.client_id, redirect_uri: "https://app.example/cb/../evil" },
    { redirect_uri: "https://evil.example/steal" }, // no client_id
    // phase-2 error (bad method) with a bad redirect must still not redirect
    { client_id: c.client_id, redirect_uri: "https://evil.example/steal", code_challenge_method: "plain" },
  ];
  for (const q of cases) {
    for (const method of ["GET", "POST"]) {
      const res = mockRes();
      const req =
        method === "GET"
          ? mockReq({ method, url: authQuery(q) })
          : mockReq({ method, url: "/api/oauth/authorize", body: Object.fromEntries(new URLSearchParams(authQuery(q).split("?")[1])) });
      await authorizeHandler(req, res);
      assert.equal(res.statusCode, 400, `${method} ${JSON.stringify(q)}`);
      assert.equal(res.getHeader("location"), undefined, "no Location header");
      assert.match(String(res.body), /<!doctype html>/i);
      assert.ok(!String(res.body).includes("evil.example"), "attacker URL not reflected");
    }
  }
});

test("authorize: phase-2 errors redirect only to the registered redirect_uri", async () => {
  const r = oauthRedis();
  __setRedisForTests(r);
  const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
  const res = mockRes();
  await authorizeHandler(mockReq({ url: authQuery({ client_id: c.client_id, redirect_uri: "https://app.example/cb", code_challenge_method: "plain" }) }), res);
  assert.equal(res.statusCode, 302);
  const loc = new URL(res.getHeader("location"));
  assert.equal(loc.origin + loc.pathname, "https://app.example/cb");
  assert.equal(loc.searchParams.get("error"), "invalid_request");

  const ok = mockRes();
  await authorizeHandler(mockReq({ url: authQuery({ client_id: c.client_id, redirect_uri: "https://app.example/cb" }) }), ok);
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /Connect LogMem/);
});

// ───── authorize: SSRF ─────

test("authorize: private REST target is refused before any fetch, with a generic message", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched++;
      throw new Error("must not fetch");
    };
    try {
      for (const target of ["https://169.254.169.254/latest", "https://10.0.0.5/exec", "https://[::1]/exec", "http://93.184.216.34/exec"]) {
        const res = mockRes();
        await consentPost(res, { client_id: c.client_id, redirect_uri: "https://app.example/cb", response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", action: "approve", space: "acme", backend: "upstash", upstash_url: target, upstash_token: "tok" });
        assert.equal(res.statusCode, 400, target);
        assert.equal(res.getHeader("location"), undefined);
        assert.ok(/Could not connect with those credentials|must be https/.test(res.body), target);
      }
      // Private TCP target too
      const res = mockRes();
      await consentPost(res, { client_id: c.client_id, redirect_uri: "https://app.example/cb", response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", action: "approve", space: "acme", backend: "redis", redis_uri: "rediss://:pw@127.0.0.1:6379" });
      assert.equal(res.statusCode, 400);
      assert.match(res.body, /Could not connect with those credentials/);
      assert.equal(fetched, 0);
      assert.equal([...r.data.keys()].filter((k) => k.startsWith("lm:oauth:code:")).length, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test("authorize: production without KEK refuses with 503 before probing", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: undefined, VERCEL_ENV: "production" }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const res = mockRes();
    await consentPost(res, { client_id: c.client_id, redirect_uri: "https://app.example/cb", response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", action: "approve", space: "acme", backend: "upstash", upstash_url: "https://93.184.216.34/exec", upstash_token: "tok" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.getHeader("location"), undefined);
  });
});

// ───── token ─────

test("token: production without KEK => 503 temporarily_unavailable", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: undefined, VERCEL_ENV: "production" }, async () => {
    __setRedisForTests(oauthRedis());
    const res = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token: "x", client_id: "cli_x" } }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, "temporarily_unavailable");
  });
});

test("token: client_secret_post is compared in constant time and a code is single-use", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "client_secret_post" });
    const verifier = "v".repeat(50);
    const code = await saveAuthCode({
      client_id: c.client_id,
      redirect_uri: "https://app.example/cb",
      code_challenge: sha256base64url(verifier),
      code_challenge_method: "S256",
      scope: "mcp",
      upstash_url: "https://example.com/exec",
      upstash_token: "t",
      backend: { kind: "upstash", url: "https://example.com/exec", token: "t" },
      sub: "rest:example.com",
      space: "acme",
    });
    const body = { grant_type: "authorization_code", code, redirect_uri: "https://app.example/cb", client_id: c.client_id, code_verifier: verifier };

    for (const wrong of [undefined, "", c.client_secret.slice(0, -1), c.client_secret + "x"]) {
      const res = mockRes();
      await tokenHandler(mockReq({ method: "POST", body: { ...body, client_secret: wrong } }), res);
      assert.equal(res.statusCode, 401, String(wrong));
    }
    const ok = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { ...body, client_secret: c.client_secret } }), ok);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(JSON.parse(ok.body).access_token);

    const replay = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { ...body, client_secret: c.client_secret } }), replay);
    assert.equal(replay.statusCode, 400);
    assert.equal(JSON.parse(replay.body).error, "invalid_grant");
  });
});

test("token: server errors do not echo internal messages", async () => {
  __setRedisForTests(async () => {
    throw new Error("redis-rest WRONGPASS secret-ish detail");
  });
  const res = mockRes();
  await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token: "x", client_id: "cli_x" } }), res);
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("WRONGPASS"));
});
