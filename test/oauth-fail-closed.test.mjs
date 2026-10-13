// PR #6 re-verification issue 4 (MEDIUM): outside VERCEL_ENV=production the
// OAuth store failed open (plaintext creds with no KEK, UPSTASH_* fallback).
// Now only local dev (VERCEL_ENV unset or "development") or an explicit
// LOGMEM_OAUTH_ALLOW_INSECURE=1 may do that; preview fails closed like prod.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setRedisForTests,
  mintTokens,
  saveAuthCode,
  lookupAccessToken,
  assertKekReady,
  getClient,
  insecureAllowed,
  sha256hex,
  KEY,
  KekMissingError,
  StorageConfigError,
} from "../api/oauth/_lib/storage.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => __setRedisForTests(null));

const creds = () => ({ client_id: "cli_x", scope: "mcp", sub: "rest:e.example", space: "acme", upstash_url: "https://e.example/exec", upstash_token: "SECRET", backend: { kind: "upstash", url: "https://e.example/exec", token: "SECRET" } });
const NO_KEK = { LOGMEM_OAUTH_KEK: undefined, LOGMEM_OAUTH_ALLOW_INSECURE: undefined };
const SHARED = { LOGMEM_DEPLOY_REST_URL: undefined, LOGMEM_DEPLOY_REST_TOKEN: undefined, UPSTASH_REDIS_REST_URL: "https://shared.example", UPSTASH_REDIS_REST_TOKEN: "shared-token" };

test("fail-closed: insecureAllowed only for local dev or the explicit flag, never production", () => {
  assert.equal(insecureAllowed({}), true);
  assert.equal(insecureAllowed({ VERCEL_ENV: "development" }), true);
  assert.equal(insecureAllowed({ VERCEL_ENV: "preview" }), false);
  assert.equal(insecureAllowed({ VERCEL_ENV: "staging" }), false, "custom environments fail closed");
  assert.equal(insecureAllowed({ VERCEL_ENV: "production" }), false);
  assert.equal(insecureAllowed({ VERCEL_ENV: "preview", LOGMEM_OAUTH_ALLOW_INSECURE: "1" }), true);
  assert.equal(insecureAllowed({ VERCEL_ENV: "preview", LOGMEM_OAUTH_ALLOW_INSECURE: "true" }), false, "only the literal 1");
  assert.equal(insecureAllowed({ VERCEL_ENV: "production", LOGMEM_OAUTH_ALLOW_INSECURE: "1" }), false, "flag ignored in production");
});

test("fail-closed: preview without a KEK refuses to mint, save codes, or open plaintext records", async () => {
  await withEnv({ ...NO_KEK, VERCEL_ENV: "preview" }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    assert.throws(() => assertKekReady(), KekMissingError);
    await assert.rejects(() => mintTokens(creds()), KekMissingError);
    await assert.rejects(() => saveAuthCode(creds()), KekMissingError);
    assert.equal(r.data.size, 0, "nothing written");

    // A plaintext record written by an earlier fail-open build is not honored.
    const tok = "a".repeat(64);
    r.data.set(KEY.access(sha256hex(tok)), { type: "string", value: JSON.stringify({ client_id: "cli_x", space: "acme", creds: { enc: "none", data: { upstash_token: "SECRET" } } }) });
    const w = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await lookupAccessToken(tok), null);
    } finally {
      console.warn = w;
    }

    const res = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token: "x", client_id: "cli_x" } }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, "temporarily_unavailable");
  });
});

test("fail-closed: preview never falls back to the shared UPSTASH_* Redis", async () => {
  __setRedisForTests(null);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ result: null }), { status: 200 });
  };
  try {
    await withEnv({ ...SHARED, VERCEL_ENV: "preview", LOGMEM_OAUTH_ALLOW_INSECURE: undefined }, async () => {
      await assert.rejects(() => getClient("cli_x"), StorageConfigError);
    });
    assert.deepEqual(seen, [], "no request reached the shared Redis");

    // Local dev and the explicit opt-in still use the fallback.
    for (const env of [{ VERCEL_ENV: undefined }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "preview", LOGMEM_OAUTH_ALLOW_INSECURE: "1" }]) {
      await withEnv({ ...SHARED, LOGMEM_OAUTH_ALLOW_INSECURE: undefined, ...env }, async () => {
        assert.equal(await getClient("cli_x"), null);
      });
    }
    assert.equal(seen.length, 3);
    assert.ok(seen.every((u) => u.startsWith("https://shared.example")));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fail-closed: local dev and the explicit flag store plaintext; a KEK seals everywhere", async () => {
  for (const env of [{ VERCEL_ENV: undefined }, { VERCEL_ENV: "development" }, { VERCEL_ENV: "preview", LOGMEM_OAUTH_ALLOW_INSECURE: "1" }]) {
    await withEnv({ ...NO_KEK, ...env }, async () => {
      const r = oauthRedis();
      __setRedisForTests(r);
      const t = await mintTokens(creds());
      assert.equal(JSON.parse(r.data.get(KEY.access(sha256hex(t.access_token))).value).creds.enc, "none");
      assert.equal((await lookupAccessToken(t.access_token)).upstash_token, "SECRET");
    });
  }
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: "preview" }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const t = await mintTokens(creds());
    assert.equal(JSON.parse(r.data.get(KEY.access(sha256hex(t.access_token))).value).creds.enc, "aes-256-gcm");
    assert.equal((await lookupAccessToken(t.access_token)).upstash_token, "SECRET");
  });
});
