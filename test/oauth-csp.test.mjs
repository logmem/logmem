// PR #6 re-verification issue 2 (MEDIUM): the site-wide CSP's form-action 'self'
// blocked the consent form's 302 to the client's redirect_uri in Chromium.
// Fix: vercel.json never sends its CSP on /api/oauth/authorize, and the
// function sends exactly one full policy naming the redirect_uri origin.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __setRedisForTests, registerClient } from "../api/oauth/_lib/storage.mjs";
import authorizeHandler, { consentCsp, ERROR_CSP } from "../api/oauth/authorize.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, consentSession, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => __setRedisForTests(null));

const KEK = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

/**
 * Compile a vercel.json `source` the way @vercel/routing-utils does
 * (path-to-regexp v6, strict + sensitive): literal text is escaped, a
 * parenthesised group is a raw regex. Named params are not used in this
 * repo's header rules, so they are rejected rather than emulated.
 */
function sourceToRegex(source) {
  assert.ok(!/:[A-Za-z_]/.test(source), `named params not emulated: ${source}`);
  let out = "";
  for (let i = 0; i < source.length; ) {
    if (source[i] === "(") {
      assert.notEqual(source[i + 1], "?", "path-to-regexp v6: a group cannot start with ?");
      let depth = 1;
      let j = i + 1;
      let pat = "";
      while (j < source.length && depth) {
        if (source[j] === "\\") {
          pat += source[j] + source[j + 1];
          j += 2;
          continue;
        }
        if (source[j] === "(") {
          assert.equal(source[j + 1], "?", "path-to-regexp v6: no nested capturing groups");
          depth++;
        }
        if (source[j] === ")" && --depth === 0) break;
        pat += source[j++];
      }
      out += `(${pat})`;
      i = j + 1;
    } else {
      out += source[i].replace(/[.+*?^${}()|[\]\\/]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

const cspRules = vercel.headers.filter((h) => h.headers.some((x) => x.key.toLowerCase() === "content-security-policy"));
const cspFor = (path) => cspRules.filter((h) => sourceToRegex(h.source).test(path));
const GLOBAL_CSP = cspRules.find((h) => h.source.startsWith("/((?!")).headers.find((x) => x.key === "Content-Security-Policy").value;

test("csp: vercel.json sends no CSP on /api/oauth/authorize but keeps it everywhere else", () => {
  for (const p of ["/api/oauth/authorize", "/api/oauth/authorize/"]) {
    assert.deepEqual(cspFor(p), [], `${p} must not get a vercel.json CSP`);
  }
  for (const p of ["/", "/docs", "/api/oauth/token", "/api/oauth/register", "/api/oauth/authorizex", "/api/oauth/authorize/x", "/app"]) {
    assert.ok(cspFor(p).length >= 1, `${p} keeps the site CSP`);
  }
  // The non-CSP security headers still apply site-wide, including authorize.
  const global = vercel.headers.find((h) => h.source === "/(.*)");
  const keys = global.headers.map((x) => x.key);
  assert.ok(keys.includes("X-Content-Type-Options") && keys.includes("X-Frame-Options") && keys.includes("Referrer-Policy"));
  assert.ok(!keys.includes("Content-Security-Policy"));
});

test("csp: function policy = global policy with form-action widened to the redirect_uri origin", () => {
  const strip = (p) => p.split(";").map((d) => d.trim()).filter((d) => d && !d.startsWith("form-action"));
  assert.deepEqual(strip(consentCsp("https://app.example/cb")), strip(GLOBAL_CSP), "same directives as vercel.json");
  assert.match(consentCsp("https://app.example/cb?x=1"), /form-action 'self' https:\/\/app\.example$/);
  assert.match(consentCsp("http://127.0.0.1:8765/callback"), /form-action 'self' http:\/\/127\.0\.0\.1:8765$/);
  assert.match(consentCsp("not a url"), /form-action 'self'$/);
  assert.match(consentCsp("https://my_app.example/cb"), /form-action 'self' https:\/\/my_app\.example$/, "underscore hosts allowed");
  assert.match(ERROR_CSP, /form-action 'none'$/);
});

test("csp: consent page sends exactly one CSP with the right form-action; error pages send form-action 'none'", async () => {
  await withEnv(KEK, async () => {
    __setRedisForTests(oauthRedis());
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const q = { response_type: "code", client_id: c.client_id, redirect_uri: "https://app.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "st", scope: "mcp" };

    // Record every setHeader call so a second CSP header could not hide.
    const { res } = await consentSession(authorizeHandler, q);
    const csp = res.getHeader("content-security-policy");
    assert.equal(typeof csp, "string", "one header value, not an array");
    assert.equal(csp.match(/form-action/g).length, 1, "exactly one form-action directive");
    assert.match(csp, /(^|; )form-action 'self' https:\/\/app\.example(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);

    const calls = [];
    const spy = mockRes();
    const orig = spy.setHeader.bind(spy);
    spy.setHeader = (k, v) => {
      calls.push([k.toLowerCase(), v]);
      return orig(k, v);
    };
    await authorizeHandler(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(q) }), spy);
    assert.equal(calls.filter(([k]) => k === "content-security-policy").length, 1, "CSP set exactly once");

    const err = mockRes();
    await authorizeHandler(mockReq({ url: "/api/oauth/authorize?client_id=nope&redirect_uri=https://x.example" }), err);
    assert.equal(err.statusCode, 400);
    assert.equal(err.getHeader("content-security-policy"), ERROR_CSP);
  });
});

// ───── PR #6 re-verification INFO items ─────

test("info: code_challenge must be 43-128 base64url chars (redirects invalid_request otherwise)", async () => {
  await withEnv(KEK, async () => {
    __setRedisForTests(oauthRedis());
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const q = (code_challenge) => ({ response_type: "code", client_id: c.client_id, redirect_uri: "https://app.example/cb", code_challenge, code_challenge_method: "S256", state: "st" });
    for (const bad of ["c", "x".repeat(42), "x".repeat(129), "a".repeat(42) + "=", "a".repeat(42) + "+", "a".repeat(42) + "/", "a b".repeat(20)]) {
      const res = mockRes();
      await authorizeHandler(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(q(bad)) }), res);
      assert.equal(res.statusCode, 302, bad);
      const loc = new URL(res.getHeader("location"));
      assert.equal(loc.origin, "https://app.example");
      assert.equal(loc.searchParams.get("error"), "invalid_request");
      assert.match(loc.searchParams.get("error_description"), /code_challenge/);
    }
    for (const good of ["x".repeat(43), "A-_z9".repeat(20) + "abc", "y".repeat(128)]) {
      const res = mockRes();
      await authorizeHandler(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(q(good)) }), res);
      assert.equal(res.statusCode, 200, good);
    }
  });
});

test("info: /authorize sends no Access-Control-Allow-Origin", async () => {
  await withEnv(KEK, async () => {
    __setRedisForTests(oauthRedis());
    const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
    const { res } = await consentSession(authorizeHandler, { response_type: "code", client_id: c.client_id, redirect_uri: "https://app.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
    assert.equal(res.getHeader("access-control-allow-origin"), undefined);
    const err = mockRes();
    await authorizeHandler(mockReq({ url: "/api/oauth/authorize?client_id=nope&redirect_uri=https://x.example" }), err);
    assert.equal(err.getHeader("access-control-allow-origin"), undefined);
  });
});

test("info: the 405 response carries the error CSP too", async () => {
  const res = mockRes();
  await authorizeHandler(mockReq({ method: "PUT", url: "/api/oauth/authorize" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.getHeader("content-security-policy"), ERROR_CSP);
});
