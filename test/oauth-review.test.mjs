// Regression tests for the PR #6 security review findings.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setRedisForTests,
  registerClient,
  saveAuthCode,
  mintTokens,
  consumeRefresh,
  sha256base64url,
  sha256hex,
  sealRecord,
} from "../api/oauth/_lib/storage.mjs";
import { validateRegistration } from "../api/oauth/register.mjs";
import authorizeHandler, { issueCsrf, verifyCsrf } from "../api/oauth/authorize.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import { resolveAuth, __clearTargetCache } from "../src/http/auth.mjs";
import { isBlockedIp } from "../src/http/net-guard.mjs";
import { migrateLegacy } from "../scripts/oauth-legacy-seal.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, consentSession, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => {
  __setRedisForTests(null);
  __clearTargetCache();
});

const KEK = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };
const baseQuery = (client_id) => ({ response_type: "code", client_id, redirect_uri: "https://app.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "st", scope: "mcp" });

// ───── #9 consent: anti-framing + CSRF ─────

test("review #9: consent and error pages forbid framing", async () => {
  await withEnv(KEK, async () => {
    __setRedisForTests(oauthRedis());
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const { res } = await consentSession(authorizeHandler, baseQuery(c.client_id));
    assert.equal(res.getHeader("x-frame-options"), "DENY");
    assert.match(res.getHeader("content-security-policy"), /frame-ancestors 'none'/);
    assert.match(String(res.getHeader("set-cookie")), /HttpOnly; Secure; SameSite=Strict/);
    const err = mockRes();
    await authorizeHandler(mockReq({ url: "/api/oauth/authorize?client_id=nope&redirect_uri=https://x.example" }), err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.getHeader("x-frame-options"), "DENY");
    assert.match(err.getHeader("content-security-policy"), /frame-ancestors 'none'/);
  });
});

test("review #9: consent POST requires a CSRF token bound to the cookie nonce and the request params", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const q = baseQuery(c.client_id);
    const { cookie, csrf_token } = await consentSession(authorizeHandler, q);
    assert.match(csrf_token, /^\d+\.[0-9a-f]{64}$/);
    const post = async (body, headers = {}) => {
      const res = mockRes();
      await authorizeHandler(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...q, action: "deny", ...body }, headers }), res);
      return res;
    };
    // no cookie (cross-site POST: SameSite=Strict cookie is not sent)
    assert.equal((await post({ csrf_token })).statusCode, 403);
    // no token
    assert.equal((await post({}, { cookie })).statusCode, 403);
    // forged token
    assert.equal((await post({ csrf_token: `${Math.floor(Date.now() / 1000) + 600}.${"0".repeat(64)}` }, { cookie })).statusCode, 403);
    // token minted for different params (attacker swaps code_challenge)
    assert.equal((await post({ csrf_token, code_challenge: "y".repeat(43) }, { cookie })).statusCode, 403);
    // other session's cookie
    assert.equal((await post({ csrf_token }, { cookie: "lm_oauth_csrf=" + "a".repeat(32) })).statusCode, 403);
    // nothing redirected, nothing saved
    assert.equal([...r.data.keys()].filter((k) => k.startsWith("lm:oauth:code:")).length, 0);
    // the genuine form works
    const ok = await post({ csrf_token }, { cookie });
    assert.equal(ok.statusCode, 302);
    assert.equal(new URL(ok.getHeader("location")).searchParams.get("error"), "access_denied");
  });
});

test("review #9: CSRF tokens expire", () => {
  const nonce = "c".repeat(32);
  const params = { client_id: "cli_a", redirect_uri: "https://app.example/cb" };
  const t = issueCsrf(nonce, params, 1000);
  assert.equal(verifyCsrf(nonce, t, params, 1000), true);
  assert.equal(verifyCsrf(nonce, t, params, 1000 + 601), false);
  assert.equal(verifyCsrf(nonce, t, { ...params, redirect_uri: "https://app.example/other" }, 1000), false);
});

// ───── #8 register '#', TTL slides on issuance ─────

test("review #8: empty-fragment redirect_uri is rejected", () => {
  assert.ok(validateRegistration({ redirect_uris: ["https://app.example/cb#"] }).error);
  assert.ok(validateRegistration({ redirect_uris: ["https://app.example/c#b"] }).error);
});

test("review #8 + #3: token issuance slides client TTL; mismatched client cannot burn a refresh token", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const a = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const evil = await registerClient({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
    const verifier = "v".repeat(50);
    const code = await saveAuthCode({ client_id: a.client_id, redirect_uri: "https://app.example/cb", code_challenge: sha256base64url(verifier), code_challenge_method: "S256", scope: "mcp", upstash_url: "https://e.example/exec", upstash_token: "t", backend: { kind: "upstash", url: "https://e.example/exec", token: "t" }, sub: "rest:e.example", space: "acme" });
    r.ttls.delete(`lm:oauth:client:${a.client_id}`);
    const res = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "authorization_code", code, redirect_uri: "https://app.example/cb", client_id: a.client_id, code_verifier: verifier } }), res);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(r.ttls.get(`lm:oauth:client:${a.client_id}`), 30 * 24 * 3600, "slid after issuance");
    const { refresh_token } = JSON.parse(res.body);

    const steal = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token, client_id: evil.client_id } }), steal);
    assert.equal(steal.statusCode, 400);
    assert.ok(r.data.has(`lm:oauth:rt:${sha256hex(refresh_token)}`), "victim's refresh token survives");

    const ok = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token, client_id: a.client_id } }), ok);
    assert.equal(ok.statusCode, 200, ok.body);
  });
});

test("review #3: concurrent first use of a refresh token never yields more than original + one grace", async () => {
  await withEnv(KEK, async () => {
    for (const getdel of [true, false]) {
      __setRedisForTests(oauthRedis({ getdel }));
      const t = await mintTokens({ client_id: "cli_x", scope: "mcp", space: "s", backend: { kind: "redis", uri: "rediss://h" } });
      const warn = console.warn;
      console.warn = () => {};
      try {
        const got = (await Promise.all([1, 2, 3, 4].map(() => consumeRefresh(t.refresh_token, "cli_x")))).filter((g) => g && g.rec);
        assert.ok(got.length >= 1 && got.length <= 2, `getdel=${getdel} got ${got.length}`);
        assert.ok(got.filter((g) => !g.grace).length === 1);
      } finally {
        console.warn = warn;
      }
    }
  });
});

// ───── #4 SSRF re-check past consent, #10 constant-time break-glass ─────

test("review #4: an OAuth backend that now resolves privately is refused at use time; env backend skipped", async () => {
  await withEnv(KEK, async () => {
    __setRedisForTests(oauthRedis());
    const url = "https://redis.example/exec";
    const t = await mintTokens({ client_id: "cli_x", scope: "mcp", sub: "rest:redis.example", space: "acme", upstash_url: url, upstash_token: "t", backend: { kind: "upstash", url, token: "t" } });
    const req = mockReq({ method: "POST", headers: { authorization: `Bearer ${t.access_token}` } });
    const env = { VERCEL_ENV: "production" };
    let lookups = 0;
    const dns = (addr) => async () => {
      lookups++;
      return [{ address: addr, family: 4 }];
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const pub = await resolveAuth(req, {}, env, { lookup: dns("8.8.8.8") });
      assert.equal(pub.source, "oauth");
      assert.equal(pub.backend.url, url);
      // cached for ~60s: no second lookup
      await resolveAuth(req, {}, env, { lookup: dns("8.8.8.8") });
      assert.equal(lookups, 1);

      __clearTargetCache();
      const rebound = await resolveAuth(req, {}, env, { lookup: dns("169.254.169.254") });
      assert.equal(rebound.backend, null, "rebound to metadata IP => unauthenticated");
      assert.equal(rebound.source, "none");

      // The deploy's own env backend is trusted (no lookup at all).
      __clearTargetCache();
      lookups = 0;
      const own = await resolveAuth(req, {}, { ...env, UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: "t" }, { lookup: dns("10.0.0.1") });
      assert.equal(own.source, "oauth");
      assert.equal(lookups, 0);
    } finally {
      console.warn = warn;
    }
  });
});

test("review #10: LOGMEM_DIRECT_AUTH_TOKEN still works and wrong/near values do not", async () => {
  __setRedisForTests(oauthRedis());
  const env = { VERCEL_ENV: "production", LOGMEM_DIRECT_AUTH_TOKEN: "break-glass-token-value", LOGMEM_REST_URL: "https://env.example/exec", LOGMEM_REST_TOKEN: "t" };
  const auth = (b) => resolveAuth(mockReq({ headers: { authorization: `Bearer ${b}` } }), {}, env);
  assert.equal((await auth("break-glass-token-value")).source, "env-authed");
  assert.equal((await auth("break-glass-token-valuE")).source, "none");
  assert.equal((await auth("break-glass-token-valu")).source, "none");
});

// ───── #5 net-guard additions ─────

test("review #5: Teredo, local-use NAT64 and SIIT ranges are blocked", () => {
  for (const ip of ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1", "64:ff9b:1::a00:1", "64:ff9b:1:ffff::1", "::ffff:0:8.8.8.8", "::ffff:0:a00:1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["2001:4860:4860::8888", "2606:4700:4700::1111", "64:ff9b::808:808"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

// ───── #2 legacy migration script ─────

test("review #2: oauth-legacy-seal dry-run writes nothing; --apply seals with remaining TTL; skips sealed", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const rawA = "1".repeat(64);
    const rawR = "2".repeat(64);
    const rawC = "3".repeat(64);
    const put = (k, v, ttl) => {
      r.data.set(k, { type: "string", value: JSON.stringify(v) });
      if (ttl) r.ttls.set(k, ttl);
    };
    put(`lm:oauth:token:${rawA}`, { client_id: "c", space: "s", upstash_url: "https://x", upstash_token: "SECRET-A", expires_at: 9e9 }, 1234);
    put(`lm:oauth:refresh:${rawR}`, { client_id: "c", space: "s", upstash_url: "https://x", upstash_token: "SECRET-R" }, 5678);
    put(`lm:oauth:code:${rawC}`, { client_id: "c", upstash_token: "SECRET-C" }, 100);
    const sealedCodeKey = `lm:oauth:code:${"4".repeat(64)}`;
    put(sealedCodeKey, sealRecord({ client_id: "c", backend: { kind: "redis", uri: "rediss://h" } }), 600);
    const before = JSON.stringify([...r.data.entries()]);

    const logs = [];
    const dry = await migrateLegacy(r, { log: (m) => logs.push(m) });
    assert.equal(dry.apply, false);
    assert.equal(dry.actions.length, 3);
    assert.equal(JSON.stringify([...r.data.entries()]), before, "dry run writes nothing");
    assert.ok(!logs.join("\n").match(/SECRET|1111111111|2222222222/), "no secrets or raw tokens in output");

    const done = await migrateLegacy(r, { apply: true });
    assert.equal(done.sealed, 2);
    assert.equal(done.deleted, 1);
    assert.equal(done.skipped, 1);
    assert.ok(!r.data.has(`lm:oauth:token:${rawA}`) && !r.data.has(`lm:oauth:refresh:${rawR}`) && !r.data.has(`lm:oauth:code:${rawC}`));
    assert.ok(r.data.has(sealedCodeKey), "already-sealed record untouched");
    assert.equal(r.ttls.get(`lm:oauth:at:${sha256hex(rawA)}`), 1234);
    assert.equal(r.ttls.get(`lm:oauth:rt:${sha256hex(rawR)}`), 5678);
    const dump = [...r.data.values()].map((e) => e.value).join("\n");
    assert.ok(!dump.includes("SECRET-A") && !dump.includes("SECRET-R"), "migrated creds are sealed");

    // The migrated access token works through the normal hashed path.
    __setRedisForTests(r);
    const { lookupAccessToken } = await import("../api/oauth/_lib/storage.mjs");
    assert.equal((await lookupAccessToken(rawA)).upstash_token, "SECRET-A");
  });
});

test("review #2: oauth-legacy-seal --delete mode and KEK requirement", async () => {
  const r = oauthRedis();
  r.data.set(`lm:oauth:token:${"5".repeat(64)}`, { type: "string", value: JSON.stringify({ space: "s" }) });
  await withEnv({ LOGMEM_OAUTH_KEK: undefined }, async () => {
    await assert.rejects(() => migrateLegacy(r, { apply: true }), /requires LOGMEM_OAUTH_KEK/);
    const del = await migrateLegacy(r, { apply: true, mode: "delete" });
    assert.equal(del.deleted, 1);
    assert.equal(r.data.size, 0);
  });
});
