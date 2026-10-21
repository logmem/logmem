// Distribution M1: an admin signed in at logmem.si/app can connect a web client
// (Gemini, Claude web) to a fleet space as a named agent, like an agent key.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { oauthRedis, withEnv, mockReq, mockRes, consentSession, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, registerClient, consumeAuthCode, mintTokens } from "../api/oauth/_lib/storage.mjs";
import authorize from "../api/oauth/authorize.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { resolveAuth } from "../src/http/auth.mjs";

afterEach(() => __setRedisForTests(null));

const ENV = {
  LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined, LOGMEM_MANAGED: undefined,
  LOGMEM_ADMIN_PASSWORD: "test-only-admin-password", LOGMEM_ADMIN_SECRET: undefined,
  LOGMEM_SPACES: "madez,fieldnotes", LOGMEM_REST_URL: "https://bridge.example.com/exec", LOGMEM_REST_TOKEN: "env-token",
  LOGMEM_REDIS_URI: undefined, ACMI_REDIS_URI: undefined,
};
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CB = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-logmem.si";
const admin = () => issueCookie(process.env).split(";")[0];

async function setup() {
  __setRedisForTests(oauthRedis());
  const c = await registerClient({ redirect_uris: [CB], client_name: "Gemini" });
  const query = { response_type: "code", client_id: c.client_id, redirect_uri: CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st", scope: "mcp" };
  return { c, query };
}
const getPage = async (query, cookie) => {
  const res = mockRes();
  await authorize(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(query), headers: cookie ? { cookie } : {} }), res);
  return res;
};
async function post(query, extra, cookie) {
  const { cookie: csrfCookie, csrf_token } = await consentSessionWith(query, cookie);
  const res = mockRes();
  await authorize(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...query, csrf_token, action: "approve", ...extra }, headers: { cookie: [csrfCookie, cookie].filter(Boolean).join("; ") } }), res);
  return res;
}
async function consentSessionWith(query, cookie) {
  const res = await getPage(query, cookie);
  assert.equal(res.statusCode, 200, String(res.body).slice(0, 200));
  return { cookie: String(res.getHeader("set-cookie")).split(";")[0], csrf_token: String(res.body).match(/name="csrf_token" value="([^"]+)"/)[1] };
}

test("fleet: a signed-in admin sees the fleet page with the deploy's spaces and an agent name", async () => {
  await withEnv(ENV, async () => {
    const { query } = await setup();
    const res = await getPage(query, admin());
    assert.equal(res.statusCode, 200);
    const body = String(res.body);
    assert.match(body, /Connect Gemini to the fleet/);
    assert.match(body, /<option value="madez" selected>madez<\/option><option value="fieldnotes">/);
    assert.match(body, /name="agent" value="gemini"/);
    assert.match(body, /account=1/);
  });
});

test("fleet: without the admin cookie, or with account=1, the normal page shows", async () => {
  await withEnv(ENV, async () => {
    const { query } = await setup();
    assert.doesNotMatch(String((await getPage(query)).body), /to the fleet/);
    assert.doesNotMatch(String((await getPage({ ...query, account: "1" }, admin())).body), /to the fleet/);
    const forged = "lm_admin=9999999999.forged";
    assert.doesNotMatch(String((await getPage(query, forged)).body), /to the fleet/);
  });
});

test("fleet: approve mints a token pinned to the space and locked to the agent, on the deploy's backend", async () => {
  await withEnv(ENV, async () => {
    const { query } = await setup();
    const r = await post(query, { fleet: "1", space: "madez", agent: "gemini-app" }, admin());
    assert.equal(r.statusCode, 302, String(r.body).slice(0, 300));
    const loc = new URL(String(r.getHeader("location")));
    assert.equal(loc.origin + loc.pathname, CB);
    const rec = await consumeAuthCode(loc.searchParams.get("code"));
    assert.deepEqual(rec.backend, { kind: "fleet", agent: "gemini-app" });
    assert.equal(rec.space, "madez");
    assert.ok(!JSON.stringify(rec).includes("env-token"), "the code holds no backend secret");
    const tok = await mintTokens(rec);
    const auth = await resolveAuth({ headers: { authorization: `Bearer ${tok.access_token}`, "x-logmem-space": "fieldnotes" } }, {}, process.env);
    assert.equal(auth.source, "fleet-oauth");
    assert.equal(auth.space, "madez", "the token's space wins over the header");
    assert.equal(auth.pinned, true);
    assert.equal(auth.agent, "gemini-app");
    assert.deepEqual(auth.backend, { url: ENV.LOGMEM_REST_URL, token: ENV.LOGMEM_REST_TOKEN });
    // A space the deploy no longer allows is unauthenticated, never another space.
    assert.equal((await resolveAuth({ headers: { authorization: `Bearer ${tok.access_token}` } }, {}, { ...process.env, LOGMEM_SPACES: "fieldnotes" })).source, "none");
  });
});

test("fleet: approve without a valid admin session gives no code", async () => {
  await withEnv(ENV, async () => {
    const { query } = await setup();
    const { cookie, csrf_token } = await consentSessionWith(query);
    const res = mockRes();
    await authorize(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...query, csrf_token, action: "approve", fleet: "1", space: "madez", agent: "x" }, headers: { cookie } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.getHeader("location"), undefined);
  });
});

test("fleet: a space outside the deploy's list or a bad agent name is refused on the page", async () => {
  await withEnv(ENV, async () => {
    const { query } = await setup();
    const bad = await post(query, { fleet: "1", space: "someone-else", agent: "gemini-app" }, admin());
    assert.equal(bad.statusCode, 400);
    assert.match(String(bad.body), /Pick one of the listed spaces/);
    const badAgent = await post(query, { fleet: "1", space: "madez", agent: "bad name!" }, admin());
    assert.equal(badAgent.statusCode, 400);
    assert.match(String(badAgent.body), /Agent name/);
  });
});
