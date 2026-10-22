// Plugin pilot server gaps, items 3 to 8 (spec 2026-10-20-logmem-agent-plugin-design.md, section 8):
// a pinned issuer, one canonical resource (https://<issuer>/mcp), the resource stored on codes and
// tokens and checked as the audience, RFC 9207 `iss` on every authorization response, the
// logmem:read and logmem:write scopes, and RFC 7009 revocation.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setRedisForTests, registerClient, consumeAuthCode, mintTokens, lookupAccessToken, sha256base64url, KEY, sha256hex } from "../api/oauth/_lib/storage.mjs";
import authorizeHandler, { __setManagedDepsForTests } from "../api/oauth/authorize.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import revokeHandler from "../api/oauth/revoke.mjs";
import asMetadata from "../api/well-known/oauth-authorization-server.mjs";
import prMetadata from "../api/well-known/oauth-protected-resource.mjs";
import { resolveAuth, wwwAuthenticate } from "../src/http/auth.mjs";
import { issuerFor, canonicalResource, normalizeScope } from "../src/http/issuer.mjs";
import { insufficientScope } from "../api/mcp.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, consentSession, callbackOf, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => __setRedisForTests(null));

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = sha256base64url(VERIFIER);
const PINNED = { LOGMEM_ISSUER: "https://logmem.si", LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined, LOGMEM_MANAGED: undefined };

async function json(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { res, body: res.body ? JSON.parse(res.body) : null };
}

// ───── 3 + 4: pinned issuer and one canonical resource ─────

test("issuer: LOGMEM_ISSUER wins over Host and X-Forwarded-Host; production defaults to logmem.si", () => {
  const req = mockReq({ headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
  assert.equal(issuerFor(req, { LOGMEM_ISSUER: "https://logmem.si/" }), "https://logmem.si");
  assert.equal(issuerFor(req, { VERCEL_ENV: "production" }), "https://logmem.si");
  assert.equal(issuerFor(req, { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "logmem-git-x.vercel.app" }), "https://logmem-git-x.vercel.app");
  assert.equal(issuerFor(mockReq({ headers: { host: "localhost:3000", "x-forwarded-proto": "http" } }), {}), "http://localhost:3000", "local dev only");
  assert.throws(() => issuerFor(req, { LOGMEM_ISSUER: "http://logmem.si" }), /LOGMEM_ISSUER/);
  assert.throws(() => issuerFor(req, { LOGMEM_ISSUER: "https://logmem.si/mcp" }), /LOGMEM_ISSUER/);
  assert.equal(canonicalResource(req, { LOGMEM_ISSUER: "https://logmem.si" }), "https://logmem.si/mcp");
});

test("metadata: both documents use the pinned issuer, the /mcp resource, the two scopes, iss and revocation", async () => {
  await withEnv(PINNED, async () => {
    const req = mockReq({ headers: { host: "www.logmem.si", "x-forwarded-host": "attacker.example" } });
    const as = (await json(asMetadata, req)).body;
    assert.equal(as.issuer, "https://logmem.si");
    assert.equal(as.authorization_endpoint, "https://logmem.si/api/oauth/authorize");
    assert.deepEqual(as.scopes_supported, ["logmem:read", "logmem:write"]);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.revocation_endpoint, "https://logmem.si/api/oauth/revoke");
    assert.notEqual(as.revocation_endpoint, as.token_endpoint);
    const pr = (await json(prMetadata, req)).body;
    assert.equal(pr.resource, "https://logmem.si/mcp");
    assert.deepEqual(pr.authorization_servers, ["https://logmem.si"]);
    assert.deepEqual(pr.scopes_supported, ["logmem:read", "logmem:write"]);
  });
});

test("401 challenge: pinned resource_metadata, scope=, and error= when given", () => {
  const req = mockReq({ headers: { host: "attacker.example" } });
  const h = wwwAuthenticate(req, {}, { LOGMEM_ISSUER: "https://logmem.si" });
  assert.equal(h, 'Bearer realm="logmem", resource_metadata="https://logmem.si/.well-known/oauth-protected-resource", scope="logmem:read logmem:write"');
  assert.match(wwwAuthenticate(req, { error: "invalid_token" }, { LOGMEM_ISSUER: "https://logmem.si" }), /, error="invalid_token"$/);
  assert.match(wwwAuthenticate(req, { error: "insufficient_scope", scope: "logmem:read logmem:write" }, { LOGMEM_ISSUER: "https://logmem.si" }), /scope="logmem:read logmem:write", error="insufficient_scope"/);
});

test("old /api/mcp connectors: path-specific metadata names /api/mcp so SDK prefix checks pass; tokens stay bound to /mcp", async () => {
  await withEnv(PINNED, async () => {
    const pr = (url) => json(prMetadata, mockReq({ url })).then((x) => x.body.resource);
    assert.equal(await pr("/api/well-known/oauth-protected-resource"), "https://logmem.si/mcp");
    assert.equal(await pr("/api/well-known/oauth-protected-resource?path=mcp"), "https://logmem.si/mcp");
    assert.equal(await pr("/api/well-known/oauth-protected-resource?path=api/mcp"), "https://logmem.si/api/mcp");
    assert.equal(await pr("/.well-known/oauth-protected-resource/api/mcp"), "https://logmem.si/api/mcp", "Vercel may pass the original path");

    const meta = (url) => wwwAuthenticate(mockReq({ url }), {}, PINNED).match(/resource_metadata="([^"]+)"/)[1];
    assert.equal(meta("/api/mcp"), "https://logmem.si/.well-known/oauth-protected-resource/api/mcp");
    assert.equal(meta("/api/mcp?config=x"), "https://logmem.si/.well-known/oauth-protected-resource/api/mcp");
    assert.equal(meta("/api/mcp?_lm_path=mcp"), "https://logmem.si/.well-known/oauth-protected-resource", "the /mcp rewrite");
    assert.equal(meta("/mcp"), "https://logmem.si/.well-known/oauth-protected-resource");
  });
});

// ───── 5 + 6 + 7: authorize binds resource and scope, and answers with iss ─────

async function setupClient() {
  const r = oauthRedis();
  __setRedisForTests(r);
  const client = await registerClient({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none" });
  const q = { response_type: "code", client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1" };
  return { r, client, q };
}

/** Managed approve with a faked Clerk session (as in managed-signin.test.mjs). Returns the redirect URL. */
async function managedApprove(r, q, extra = {}) {
  const { createMemoryRedis } = await import("../src/lib/memory-redis.mjs");
  const { inviteMany } = await import("../src/http/invites.mjs");
  __setManagedDepsForTests({
    ready: () => true,
    session: async () => ({ status: "signed-in", userId: "user_2abcDEF123ghiJKL", email: "ada@example.com" }),
    redis: () => r,
    waitlistRedis: () => createMemoryRedis(),
  });
  await inviteMany(["ada@example.com"], { redis: r });
  const { cookie, csrf_token } = await consentSession(authorizeHandler, q);
  const res = mockRes();
  await authorizeHandler(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...q, csrf_token, action: "approve", ...extra }, headers: { cookie } }), res);
  return callbackOf(res);
}

test("authorize: the code stores the canonical resource and the normalised scope; the redirect carries iss", async () => {
  await withEnv({ ...PINNED, LOGMEM_MANAGED: "1", LOGMEM_CUSTOMER_REDIS_URI: "rediss://logmem-app:pw@203.0.113.9:6380/0" }, async () => {
    try {
      const { r, q } = await setupClient();
      for (const [resource, scope, want] of [
        ["https://logmem.si/api/mcp", "mcp", "logmem:read logmem:write"],
        ["https://logmem.si/mcp", "logmem:read", "logmem:read"],
        [undefined, undefined, "logmem:read logmem:write"],
      ]) {
        const query = { ...q, ...(resource ? { resource } : {}), ...(scope ? { scope } : {}) };
        const u = await managedApprove(r, query);
        assert.equal(u.searchParams.get("iss"), "https://logmem.si");
        assert.equal(u.searchParams.get("state"), "s1");
        const rec = await consumeAuthCode(u.searchParams.get("code"));
        assert.equal(rec.resource, "https://logmem.si/mcp", String(resource));
        assert.equal(rec.scope, want);
      }
    } finally {
      __setManagedDepsForTests(null);
    }
  });
});

test("authorize: an unknown resource is refused with invalid_target, and every redirect carries iss", async () => {
  await withEnv(PINNED, async () => {
    const { q } = await setupClient();
    const bad = mockRes();
    await authorizeHandler(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams({ ...q, resource: "https://evil.example/mcp" }) }), bad);
    assert.equal(bad.statusCode, 302);
    const u = new URL(bad.getHeader("location"));
    assert.equal(u.searchParams.get("error"), "invalid_target");
    assert.equal(u.searchParams.get("iss"), "https://logmem.si");
    assert.equal(u.searchParams.get("state"), "s1");

    const { cookie, csrf_token } = await consentSession(authorizeHandler, { ...q, resource: "https://logmem.si/mcp" });
    const deny = mockRes();
    await authorizeHandler(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...q, resource: "https://logmem.si/mcp", csrf_token, action: "deny" }, headers: { cookie } }), deny);
    const d = callbackOf(deny);
    assert.equal(d.searchParams.get("error"), "access_denied");
    assert.equal(d.searchParams.get("iss"), "https://logmem.si");
  });
});

test("scopes: mcp and empty mean both; write implies read; unknown scopes are dropped", () => {
  assert.equal(normalizeScope("mcp"), "logmem:read logmem:write");
  assert.equal(normalizeScope(""), "logmem:read logmem:write");
  assert.equal(normalizeScope(undefined), "logmem:read logmem:write");
  assert.equal(normalizeScope("logmem:read"), "logmem:read");
  assert.equal(normalizeScope("logmem:write"), "logmem:read logmem:write");
  assert.equal(normalizeScope("openid logmem:read"), "logmem:read");
  assert.equal(normalizeScope("openid"), "logmem:read logmem:write");
});

// ───── 5: the token endpoint and the MCP route check the resource ─────

async function codeFor(r, client, { resource = "https://logmem.si/mcp", scope = "logmem:read" } = {}) {
  const { saveAuthCode } = await import("../api/oauth/_lib/storage.mjs");
  return saveAuthCode({
    client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: CHALLENGE, code_challenge_method: "S256",
    scope, upstash_url: null, upstash_token: null, backend: { kind: "redis", uri: "rediss://default:pw@redis.example:6380/0" }, sub: "redis:redis.example", space: "acme", resource,
  });
}

const tokenReq = (body) => mockReq({ method: "POST", url: "/api/oauth/token", body });

test("token: the resource must match the code's; tokens carry the resource and the normalised scope", async () => {
  await withEnv(PINNED, async () => {
    const { r, client } = await setupClient();
    const base = { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_verifier: VERIFIER };

    const wrong = await json(tokenHandler, tokenReq({ ...base, code: await codeFor(r, client), resource: "https://evil.example/mcp" }));
    assert.equal(wrong.res.statusCode, 400);
    assert.equal(wrong.body.error, "invalid_target");

    const alias = await json(tokenHandler, tokenReq({ ...base, code: await codeFor(r, client), resource: "https://logmem.si/api/mcp" }));
    assert.equal(alias.res.statusCode, 200, "/api/mcp is an alias of the one resource");
    assert.equal(alias.body.scope, "logmem:read");
    const tok = await lookupAccessToken(alias.body.access_token);
    assert.equal(tok.resource, "https://logmem.si/mcp");

    const legacy = await json(tokenHandler, tokenReq({ ...base, code: await codeFor(r, client, { resource: undefined, scope: "mcp" }) }));
    assert.equal(legacy.res.statusCode, 200);
    assert.equal(legacy.body.scope, "logmem:read logmem:write");
    assert.equal((await lookupAccessToken(legacy.body.access_token)).resource, "https://logmem.si/mcp", "a code from before this change binds to the canonical resource");

    const refreshed = await json(tokenHandler, tokenReq({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: alias.body.refresh_token, resource: "https://other.example/mcp" }));
    assert.equal(refreshed.body.error, "invalid_target");
  });
});

test("audience: a token for another resource is unauthenticated; a legacy token without one still works", async () => {
  await withEnv({ ...PINNED, LOGMEM_REDIS_URI: "rediss://default:pw@redis.example:6380/0" }, async () => {
    const { client } = await setupClient();
    const backend = { kind: "redis", uri: "rediss://default:pw@redis.example:6380/0" }; // the env backend: no DNS check
    const req = (t) => mockReq({ headers: { authorization: `Bearer ${t}`, host: "logmem.si" } });
    const other = await mintTokens({ client_id: client.client_id, scope: "logmem:read", backend, sub: "x", space: "acme", resource: "https://preview.example/mcp" });
    const a1 = await resolveAuth(req(other.access_token), {}, process.env);
    assert.equal(a1.backend, null);
    assert.equal(a1.error, "invalid_token");
    const mine = await mintTokens({ client_id: client.client_id, scope: "logmem:read", backend, sub: "x", space: "acme", resource: "https://logmem.si/mcp" });
    const a2 = await resolveAuth(req(mine.access_token), {}, process.env);
    assert.equal(a2.source, "oauth");
    assert.deepEqual(a2.scopes, ["logmem:read"]);
    const old = await mintTokens({ client_id: client.client_id, scope: "mcp", backend, sub: "x", space: "acme" });
    const a3 = await resolveAuth(req(old.access_token), {}, process.env);
    assert.equal(a3.source, "oauth");
    assert.deepEqual(a3.scopes, ["logmem:read", "logmem:write"]);
  });
});

test("scope gate: a read-only token may call read tools only; other credentials are not limited", () => {
  const defs = [{ name: "logmem_brief", annotations: { readOnlyHint: true } }, { name: "logmem_note", annotations: { readOnlyHint: false } }];
  const call = (name) => ({ method: "tools/call", params: { name } });
  const ro = { source: "oauth", scopes: ["logmem:read"] };
  assert.equal(insufficientScope(ro, call("logmem_brief"), defs), false);
  assert.equal(insufficientScope(ro, call("logmem_note"), defs), true);
  assert.equal(insufficientScope(ro, call("no_such_tool"), defs), true, "unknown tools fail closed");
  assert.equal(insufficientScope(ro, { method: "tools/list" }, defs), false);
  assert.equal(insufficientScope({ source: "oauth", scopes: ["logmem:read", "logmem:write"] }, call("logmem_note"), defs), false);
  assert.equal(insufficientScope({ source: "agent-key" }, call("logmem_note"), defs), false);
});

// ───── 8: RFC 7009 revocation ─────

const revokeReq = (body) => mockReq({ method: "POST", url: "/api/oauth/revoke", body });

test("revoke: a refresh token revokes the whole grant; an access token revokes itself", async () => {
  await withEnv(PINNED, async () => {
    const { r, client } = await setupClient();
    const backend = { kind: "redis", uri: "rediss://default:pw@redis.example:6380/0" };
    const t = await mintTokens({ client_id: client.client_id, scope: "logmem:read", backend, sub: "x", space: "acme", resource: "https://logmem.si/mcp" });
    const out = await json(revokeHandler, revokeReq({ token: t.refresh_token, token_type_hint: "refresh_token", client_id: client.client_id }));
    assert.equal(out.res.statusCode, 200);
    assert.equal(await lookupAccessToken(t.access_token), null, "the access token of the grant is gone");
    assert.equal(r.data.has(KEY.refresh(sha256hex(t.refresh_token))), false);

    const t2 = await mintTokens({ client_id: client.client_id, scope: "logmem:read", backend, sub: "x", space: "acme", resource: "https://logmem.si/mcp" });
    await json(revokeHandler, revokeReq({ token: t2.access_token, client_id: client.client_id }));
    assert.equal(await lookupAccessToken(t2.access_token), null);
    assert.equal(r.data.has(KEY.refresh(sha256hex(t2.refresh_token))), true, "revoking an access token leaves the refresh token");
  });
});

test("revoke: another client's token and an unknown token both answer 200 and change nothing", async () => {
  await withEnv(PINNED, async () => {
    const { client } = await setupClient();
    const other = await registerClient({ client_name: "Other", redirect_uris: ["https://other.example/cb"], token_endpoint_auth_method: "none" });
    const backend = { kind: "redis", uri: "rediss://default:pw@redis.example:6380/0" };
    const t = await mintTokens({ client_id: client.client_id, scope: "logmem:read", backend, sub: "x", space: "acme", resource: "https://logmem.si/mcp" });
    const stolen = await json(revokeHandler, revokeReq({ token: t.refresh_token, client_id: other.client_id }));
    assert.equal(stolen.res.statusCode, 200);
    assert.ok(await lookupAccessToken(t.access_token), "another client cannot revoke this grant");
    assert.equal((await json(revokeHandler, revokeReq({ token: "nope", client_id: client.client_id }))).res.statusCode, 200);
  });
});

test("revoke: no token is 400, an unknown client is 401, a confidential client needs its secret", async () => {
  await withEnv(PINNED, async () => {
    const { client } = await setupClient();
    assert.equal((await json(revokeHandler, revokeReq({ client_id: client.client_id }))).body.error, "invalid_request");
    const unknown = await json(revokeHandler, revokeReq({ token: "x", client_id: "nope" }));
    assert.equal(unknown.res.statusCode, 401);
    assert.equal(unknown.body.error, "invalid_client");
    const conf = await registerClient({ client_name: "Conf", redirect_uris: ["https://c.example/cb"], token_endpoint_auth_method: "client_secret_post" });
    assert.equal((await json(revokeHandler, revokeReq({ token: "x", client_id: conf.client_id, client_secret: "wrong" }))).res.statusCode, 401);
    assert.equal((await json(revokeHandler, revokeReq({ token: "x", client_id: conf.client_id, client_secret: conf.client_secret }))).res.statusCode, 200);
    assert.equal((await json(revokeHandler, mockReq({ method: "GET", url: "/api/oauth/revoke" }))).res.statusCode, 405);
  });
});
