// Follow-ups from the PR #23 re-verification (correlationId lmPr23Review-20261013c).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  __setRedisForTests,
  __setClockForTests,
  LEGACY_CUTOFF_MS,
  KEY,
  lookupAccessToken,
  registerClient,
  sha256base64url,
  sha256hex,
} from "../api/oauth/_lib/storage.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => {
  __setRedisForTests(null);
  __setClockForTests(null);
});

const KEK = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };

/** Seal exactly like the pre-v2 code did: constant AAD, no `v` field. */
function sealV1(creds) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(TEST_KEK_HEX, "hex"), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from("logmem-oauth-creds-v1"));
  const ct = Buffer.concat([c.update(JSON.stringify(creds), "utf8"), c.final()]);
  return { enc: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

const put = (r, k, v) => r.data.set(k, { type: "string", value: JSON.stringify(v) });

test("pr23: a v1 refresh token and auth code spliced under an attacker key mint nothing before the cutoff", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const victimCreds = {
      backend: { kind: "upstash", url: "https://victim.example/exec", token: "VICTIM-SECRET" },
      upstash_url: "https://victim.example/exec",
      upstash_token: "VICTIM-SECRET",
    };
    const plain = { client_id: c.client_id, scope: "mcp", sub: "rest:victim.example", space: "victim" };

    // Attacker-chosen bearers. The Redis key is the hash of a value they know;
    // the ciphertext is a real v1 envelope (constant AAD), so it used to open.
    const accessTok = "a".repeat(64);
    const refreshTok = "b".repeat(64);
    const code = "c".repeat(64);
    const verifier = "v".repeat(50);
    put(r, KEY.access(sha256hex(accessTok)), { ...plain, issued_at: 1, expires_at: 9e9, creds: sealV1(victimCreds) });
    put(r, KEY.refresh(sha256hex(refreshTok)), { ...plain, issued_at: 1, creds: sealV1(victimCreds) });
    put(r, KEY.code(sha256hex(code)), {
      ...plain,
      redirect_uri: "https://app.example/cb",
      code_challenge: sha256base64url(verifier),
      code_challenge_method: "S256",
      creds: sealV1(victimCreds),
    });

    const before = new Set(r.data.keys());
    const refreshRes = mockRes();
    await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token: refreshTok, client_id: c.client_id } }), refreshRes);
    assert.equal(refreshRes.statusCode, 400);
    assert.equal(JSON.parse(refreshRes.body).error, "invalid_grant");
    assert.equal(JSON.parse(refreshRes.body).access_token, undefined);

    const codeRes = mockRes();
    await tokenHandler(
      mockReq({
        method: "POST",
        body: {
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://app.example/cb",
          client_id: c.client_id,
          code_verifier: verifier,
        },
      }),
      codeRes,
    );
    assert.equal(codeRes.statusCode, 400);
    assert.equal(JSON.parse(codeRes.body).error, "invalid_grant");
    assert.equal(JSON.parse(codeRes.body).access_token, undefined);

    const added = [...r.data.keys()].filter((k) => !before.has(k));
    assert.deepEqual(added, [], `v1 consumption minted keys: ${added.join(", ")}`);
    assert.ok(![...r.data.values()].some((e) => String(e.value).includes("VICTIM-SECRET")), "victim secret stayed inside the v1 envelope");

    // Access-token lookup still serves a v1 access token until the cutoff.
    assert.equal((await lookupAccessToken(accessTok)).upstash_token, "VICTIM-SECRET");
    __setClockForTests(() => LEGACY_CUTOFF_MS + 1);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await lookupAccessToken(accessTok), null);
    } finally {
      console.warn = warn;
    }
  });
});
