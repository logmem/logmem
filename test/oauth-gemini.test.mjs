// Gemini custom apps: register with client_secret_basic, a Google relay callback and
// offline_access, then send the client_id in a Basic header at /token.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setRedisForTests, saveAuthCode, sha256base64url } from "../api/oauth/_lib/storage.mjs";
import registerHandler, { validateRegistration } from "../api/oauth/register.mjs";
import tokenHandler, { basicClient } from "../api/oauth/token.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => __setRedisForTests(null));

const GEMINI_CB = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-logmem.si";
const GEMINI_BODY = {
  client_name: "Gemini",
  redirect_uris: [GEMINI_CB],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "client_secret_basic",
  scope: "mcp offline_access",
};
const basic = (id, secret = "") => "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64");

test("gemini: registration with client_secret_basic is a public client with no secret", async () => {
  const v = validateRegistration(GEMINI_BODY);
  assert.ok(v.meta, JSON.stringify(v));
  assert.equal(v.meta.token_endpoint_auth_method, "none");
  assert.equal(v.meta.scope, "mcp offline_access");

  const r = oauthRedis();
  __setRedisForTests(r);
  const res = mockRes();
  await registerHandler(mockReq({ method: "POST", body: GEMINI_BODY }), res);
  assert.equal(res.statusCode, 201, res.body);
  const c = JSON.parse(res.body);
  assert.equal(c.token_endpoint_auth_method, "none");
  assert.ok(!c.client_secret, "no secret is issued");
  assert.deepEqual(c.redirect_uris, [GEMINI_CB]);
});

test("gemini: a refused registration is logged with its reason and no body", async () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    const res = mockRes();
    await registerHandler(mockReq({ method: "POST", body: { ...GEMINI_BODY, token_endpoint_auth_method: "private_key_jwt", client_name: "SECRET-NAME" } }), res);
    assert.equal(res.statusCode, 400);
  } finally {
    console.log = orig;
  }
  const rec = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.route === "/api/oauth/register");
  assert.ok(rec, "one log line for the refusal");
  assert.equal(rec.status, 400);
  assert.match(rec.err, /invalid_client_metadata/);
  assert.ok(!lines.join("\n").includes("SECRET-NAME"), "the body is never logged");
});

test("gemini: basicClient parses RFC 6749 form-encoded credentials", () => {
  assert.deepEqual(basicClient(basic("cli_a b", "s:ec")), { client_id: "cli_a b", client_secret: "s:ec" });
  assert.deepEqual(basicClient(basic("cli_x")), { client_id: "cli_x", client_secret: "" });
  assert.equal(basicClient("Bearer abc"), null);
  assert.equal(basicClient("Basic " + Buffer.from("nocolon").toString("base64")), null);
  assert.equal(basicClient(undefined), null);
});

test("gemini: the token exchange takes the client_id from a Basic header", async () => {
  await withEnv({ LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined }, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const reg = mockRes();
    await registerHandler(mockReq({ method: "POST", body: GEMINI_BODY }), reg);
    const c = JSON.parse(reg.body);
    const verifier = "v".repeat(50);
    const mkCode = () => saveAuthCode({
      client_id: c.client_id, redirect_uri: GEMINI_CB, code_challenge: sha256base64url(verifier), code_challenge_method: "S256",
      scope: "mcp offline_access", upstash_url: "https://example.com/exec", upstash_token: "t",
      backend: { kind: "upstash", url: "https://example.com/exec", token: "t" }, sub: "rest:example.com", space: "acme",
    });

    // A different client_id in the header and the body is refused.
    const clash = mockRes();
    await tokenHandler(mockReq({ method: "POST", headers: { authorization: basic("cli_other") }, body: { grant_type: "authorization_code", code: await mkCode(), redirect_uri: GEMINI_CB, client_id: c.client_id, code_verifier: verifier } }), clash);
    assert.equal(clash.statusCode, 401, clash.body);

    // Header only, as Gemini sends it; any secret is ignored for a public client.
    const ok = mockRes();
    await tokenHandler(mockReq({ method: "POST", headers: { authorization: basic(c.client_id, "whatever") }, body: { grant_type: "authorization_code", code: await mkCode(), redirect_uri: GEMINI_CB, code_verifier: verifier } }), ok);
    assert.equal(ok.statusCode, 200, ok.body);
    const t = JSON.parse(ok.body);
    assert.ok(t.access_token && t.refresh_token);

    // Refresh with the same Basic header.
    const ref = mockRes();
    await tokenHandler(mockReq({ method: "POST", headers: { authorization: basic(c.client_id) }, body: { grant_type: "refresh_token", refresh_token: t.refresh_token } }), ref);
    assert.equal(ref.statusCode, 200, ref.body);

    // PKCE still binds the code: a wrong verifier fails even with a valid Basic header.
    const bad = mockRes();
    await tokenHandler(mockReq({ method: "POST", headers: { authorization: basic(c.client_id) }, body: { grant_type: "authorization_code", code: await mkCode(), redirect_uri: GEMINI_CB, code_verifier: "w".repeat(50) } }), bad);
    assert.equal(bad.statusCode, 400, bad.body);
  });
});
