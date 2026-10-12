import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  __setRedisForTests,
  mintTokens,
  lookupAccessToken,
  saveAuthCode,
  consumeAuthCode,
  consumeRefresh,
  revokeAccessToken,
  registerClient,
  getClient,
  sealCreds,
  openCreds,
  loadKek,
  safeEqual,
  sha256hex,
  KekMissingError,
  StorageConfigError,
  TTL,
} from "../api/oauth/_lib/storage.mjs";
import { oauthRedis, withEnv, TEST_KEK_HEX } from "./oauth-helpers.mjs";

const SECRET = "upstash-secret-token-value";
const creds = () => ({
  client_id: "cli_x",
  scope: "mcp",
  sub: "rest:example.com",
  space: "acme",
  upstash_url: "https://example.com/exec",
  upstash_token: SECRET,
  backend: { kind: "upstash", url: "https://example.com/exec", token: SECRET },
});

afterEach(() => __setRedisForTests(null));

const allStored = (r) => [...r.data.entries()].map(([k, e]) => `${k}=${e.value}`).join("\n");

test("oauth storage: tokens are keyed by sha256(token), never the raw value", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const t = await mintTokens(creds());
    const expectHex = createHash("sha256").update(t.access_token).digest("hex");
    assert.equal(sha256hex(t.access_token), expectHex);
    assert.ok(r.data.has(`lm:oauth:token:${expectHex}`));
    assert.ok(r.data.has(`lm:oauth:refresh:${sha256hex(t.refresh_token)}`));
    const dump = allStored(r);
    assert.ok(!dump.includes(t.access_token), "raw access token must not be stored");
    assert.ok(!dump.includes(t.refresh_token), "raw refresh token must not be stored");
    assert.equal(r.ttls.get(`lm:oauth:token:${expectHex}`), TTL.access);

    const rec = await lookupAccessToken(t.access_token);
    assert.equal(rec.space, "acme");
    assert.equal(rec.backend.token, SECRET);
    assert.equal(rec.upstash_token, SECRET);
    assert.equal(await lookupAccessToken("not-a-token"), null);

    await revokeAccessToken(t.access_token);
    assert.equal(await lookupAccessToken(t.access_token), null);
  });
});

test("oauth storage: auth codes are hashed too", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const code = await saveAuthCode({ ...creds(), redirect_uri: "https://app.example/cb", code_challenge: "c" });
    assert.ok(r.data.has(`lm:oauth:code:${sha256hex(code)}`));
    assert.ok(!allStored(r).includes(code));
    assert.ok(!allStored(r).includes(SECRET), "code record creds must be sealed");
    const rec = await consumeAuthCode(code);
    assert.equal(rec.backend.token, SECRET);
    assert.equal(rec.redirect_uri, "https://app.example/cb");
  });
});

test("oauth storage: legacy raw-key access tokens still resolve (compat window)", async () => {
  const r = oauthRedis();
  __setRedisForTests(r);
  const legacy = "a".repeat(64);
  r.data.set(`lm:oauth:token:${legacy}`, { type: "string", value: JSON.stringify({ space: "old", upstash_url: "https://x", upstash_token: "t", expires_at: 9e9 }) });
  const rec = await lookupAccessToken(legacy);
  assert.equal(rec.space, "old");
  assert.equal(rec.upstash_token, "t");
});

test("oauth storage: AES-256-GCM envelope round trip, hex and base64 KEKs", () => {
  const blob = { backend: { kind: "redis", uri: "rediss://:pw@h:6379" }, upstash_url: null, upstash_token: null };
  for (const kek of [TEST_KEK_HEX, Buffer.from(TEST_KEK_HEX, "hex").toString("base64")]) {
    const env = { LOGMEM_OAUTH_KEK: kek };
    const env1 = sealCreds(blob, env);
    assert.equal(env1.enc, "aes-256-gcm");
    assert.ok(env1.iv && env1.tag && env1.ct);
    assert.ok(!JSON.stringify(env1).includes("pw@h"));
    assert.deepEqual(openCreds(env1, env), blob);
    // fresh IV each time
    assert.notEqual(sealCreds(blob, env).iv, env1.iv);
    // tamper -> auth failure
    const ct = Buffer.from(env1.ct, "base64");
    ct[0] ^= 1;
    assert.throws(() => openCreds({ ...env1, ct: ct.toString("base64") }, env));
    // wrong key -> auth failure
    assert.throws(() => openCreds(env1, { LOGMEM_OAUTH_KEK: "ff".repeat(32) }));
  }
  assert.equal(loadKek({}), null);
  assert.throws(() => loadKek({ LOGMEM_OAUTH_KEK: "tooshort" }), StorageConfigError);
});

test("oauth storage: stored token record has {enc,iv,tag,ct} and no plaintext creds", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const t = await mintTokens(creds());
    const stored = JSON.parse(r.data.get(`lm:oauth:token:${sha256hex(t.access_token)}`).value);
    assert.equal(stored.creds.enc, "aes-256-gcm");
    assert.equal(stored.backend, undefined);
    assert.equal(stored.upstash_token, undefined);
    assert.ok(!allStored(r).includes(SECRET));
    // A rotated/wrong KEK makes the token unusable rather than throwing.
    await withEnv({ LOGMEM_OAUTH_KEK: "ee".repeat(32) }, async () => {
      assert.equal(await lookupAccessToken(t.access_token), null);
    });
  });
});

test("oauth storage: production without KEK refuses to mint; dev stores plaintext with warning", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: undefined, VERCEL_ENV: "production" }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    await assert.rejects(() => mintTokens(creds()), KekMissingError);
    await assert.rejects(() => saveAuthCode(creds()), KekMissingError);
    assert.equal(r.data.size, 0, "nothing written");
  });
  await withEnv({ LOGMEM_OAUTH_KEK: undefined, VERCEL_ENV: "preview" }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const t = await mintTokens(creds());
    const stored = JSON.parse(r.data.get(`lm:oauth:token:${sha256hex(t.access_token)}`).value);
    assert.equal(stored.creds.enc, "none");
    assert.match(stored.creds.warning, /LOGMEM_OAUTH_KEK unset/);
    assert.equal((await lookupAccessToken(t.access_token)).upstash_token, SECRET);
  });
});

for (const getdel of [true, false]) {
  const label = getdel ? "GETDEL" : "SET NX lock fallback";
  test(`oauth storage: concurrent auth-code double consume is refused (${label})`, async () => {
    await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
      const r = oauthRedis({ getdel });
      __setRedisForTests(r);
      const code = await saveAuthCode(creds());
      const results = await Promise.all([consumeAuthCode(code), consumeAuthCode(code), consumeAuthCode(code)]);
      assert.equal(results.filter(Boolean).length, 1, "exactly one consumer wins");
      assert.equal(await consumeAuthCode(code), null);
      if (!getdel) assert.ok(r.calls.some(([c, , , nx]) => c === "SET" && nx === "NX"));
    });
  });

  test(`oauth storage: refresh is single-use with one 60s grace reuse (${label})`, async () => {
    await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
      const r = oauthRedis({ getdel });
      __setRedisForTests(r);
      const t = await mintTokens(creds());
      const first = await consumeRefresh(t.refresh_token);
      assert.equal(first.space, "acme");
      assert.equal(r.ttls.get(`lm:oauth:refresh-grace:${sha256hex(t.refresh_token)}`), 60);
      const grace = await consumeRefresh(t.refresh_token);
      assert.equal(grace?.space, "acme", "one retry inside the grace window");
      assert.equal(await consumeRefresh(t.refresh_token), null, "third use refused");

      // Concurrent first-use: the main key goes to exactly one caller.
      const t2 = await mintTokens(creds());
      const h = sha256hex(t2.refresh_token);
      const before = r.data.has(`lm:oauth:refresh:${h}`);
      const both = await Promise.all([consumeRefresh(t2.refresh_token), consumeRefresh(t2.refresh_token), consumeRefresh(t2.refresh_token)]);
      assert.ok(before);
      assert.ok(both.filter(Boolean).length <= 2, "never more than original + one grace use");
      assert.ok(both.filter(Boolean).length >= 1);
    });
  });
}

test("oauth storage: clients get a 30-day TTL that slides on use", async () => {
  const r = oauthRedis();
  __setRedisForTests(r);
  const c = await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "none" });
  assert.equal(c.client_secret, null);
  assert.equal(r.ttls.get(`lm:oauth:client:${c.client_id}`), 30 * 24 * 3600);
  r.ttls.delete(`lm:oauth:client:${c.client_id}`);
  assert.equal((await getClient(c.client_id)).client_id, c.client_id);
  assert.equal(r.ttls.get(`lm:oauth:client:${c.client_id}`), 30 * 24 * 3600);
  const s = await registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_post" });
  assert.equal(typeof s.client_secret, "string");
});

test("oauth storage: safeEqual is a correct constant-time equality", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(undefined, "x"), false);
});

test("oauth storage: production deploy Redis requires LOGMEM_DEPLOY_* (no UPSTASH fallback)", async () => {
  __setRedisForTests(null);
  await withEnv(
    { VERCEL_ENV: "production", LOGMEM_DEPLOY_REST_URL: undefined, LOGMEM_DEPLOY_REST_TOKEN: undefined, UPSTASH_REDIS_REST_URL: "https://shared.example", UPSTASH_REDIS_REST_TOKEN: "shared" },
    async () => {
      await assert.rejects(() => getClient("cli_x"), StorageConfigError);
    },
  );
});

test("oauth storage: deploy Redis fetch has a timeout and checks res.ok", async () => {
  __setRedisForTests(null);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response("<html>upstream exploded with secrets</html>", { status: 502 });
  };
  try {
    await withEnv({ VERCEL_ENV: "production", LOGMEM_DEPLOY_REST_URL: "https://deploy.example", LOGMEM_DEPLOY_REST_TOKEN: "deploy-token" }, async () => {
      await assert.rejects(() => getClient("cli_x"), (e) => {
        assert.match(e.message, /HTTP 502/);
        assert.ok(!e.message.includes("secrets"), "upstream body not echoed");
        return true;
      });
    });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].init.signal instanceof AbortSignal, "fetch carries an AbortSignal timeout");
  } finally {
    globalThis.fetch = realFetch;
  }
});
