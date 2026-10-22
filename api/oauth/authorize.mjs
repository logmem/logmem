// OAuth 2.1 authorization endpoint with PKCE.
//
// GET  /api/oauth/authorize?response_type=code&client_id=...&redirect_uri=...
//        &code_challenge=...&code_challenge_method=S256&state=...&scope=mcp
//   → renders consent HTML form (user enters a Redis URI, or a REST bridge URL + token)
// POST /api/oauth/authorize
//   form-encoded — issues auth code, redirects to redirect_uri with ?code=...&state=...
//
// PKCE is REQUIRED. We accept S256 only (per MCP spec). plain is rejected.
//
// Redirect safety: client_id and redirect_uri are validated (client exists,
// redirect_uri exactly registered) BEFORE anything can redirect. Failures there
// render a 400 page and never 302, so this endpoint is not an open redirect.
//
// SSRF safety: user-supplied backend targets pass assertPublicTarget
// (src/http/net-guard.mjs) before any probe, the REST probe does not follow
// redirects and times out, and probe failures show one generic message —
// upstream error bodies are never echoed to the page.
//
// Clickjacking / CSRF: every HTML response sends one full CSP (frame-ancestors
// 'none'; see consentCsp) and X-Frame-Options DENY. The consent form carries a CSRF token =
// exp.HMAC(key, [nonce, exp, auth-request params]) where nonce lives in a
// SameSite=Strict HttpOnly cookie set with the form. POST verifies both, so a
// cross-site page cannot submit (or pre-fill) consent for the user.
//
// Plugin pilot (spec 2026-10-20-logmem-agent-plugin-design.md, section 8):
// - resource (RFC 8707): bound into the CSRF token and stored on the code as
//   the one canonical resource (<issuer>/mcp). Any other value is invalid_target.
// - scope: stored as "logmem:read" or "logmem:read logmem:write" (normalizeScope).
// - iss (RFC 9207): every redirect to the client, success or error, names the issuer.

import { getClient, saveAuthCode, assertKekReady, csrfKey, hmacHex, safeEqual, randomToken } from "./_lib/storage.mjs";
import { restEndpoint } from "../../src/lib/redis-rest.mjs";
import { validateKeySegments } from "../../src/lib/helpers.mjs";
import { assertPublicTarget } from "../../src/http/net-guard.mjs";
import { clerkSession, clerkConfigured } from "../../src/http/clerk.mjs";
import { accountFor } from "../../src/http/accounts.mjs";
import { customerRedis } from "../../src/http/jail.mjs";
import { serverRedis } from "../../src/http/onboarding.mjs";
import { checkAgentId } from "../../src/core/keys.mjs";
import { issuerFor, bindResource, normalizeScope, SCOPE_WRITE } from "../../src/http/issuer.mjs";
import { isAdmin } from "../../src/http/admin-auth.mjs";
import { keySpaces } from "../../src/http/agent-keys.mjs";

const PROBE_TIMEOUT_MS = 5000;
const CONNECT_FAILED = "Could not connect with those credentials";
const CSRF_COOKIE = "lm_oauth_csrf";
const CSRF_TTL_S = 600;
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const BOUND_PARAMS = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "response_type", "resource"];

// vercel.json excludes this path from the site-wide CSP, so this function
// sends the ONLY Content-Security-Policy header here. BASE_CSP must stay
// identical to the global policy in vercel.json apart from form-action
// (test/oauth-csp.test.mjs checks this). form-action has to name the client's
// redirect_uri origin: Chromium enforces the consent document's form-action on
// every hop of the form navigation, including our 302 to the client callback.
const BASE_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
];
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9._-]+(?::\d{1,5})?$|^https?:\/\/\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** CSP for the consent page: form-action 'self' plus the (already validated) redirect_uri origin. */
export function consentCsp(redirect_uri) {
  let origin = null;
  try {
    origin = new URL(redirect_uri).origin;
  } catch {
    // unreachable for a validated redirect_uri; fall back to 'self' only
  }
  const formAction = origin && SAFE_ORIGIN.test(origin) ? `form-action 'self' ${origin}` : "form-action 'self'";
  return [...BASE_CSP, formAction].join("; ");
}

/** CSP for error pages: they hold no form, so nothing may be submitted. */
export const ERROR_CSP = [...BASE_CSP, "form-action 'none'"].join("; ");

function htmlHeaders(res, status, csp) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", csp);
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie || "");
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function csrfMac(nonce, exp, params) {
  return hmacHex(csrfKey(), JSON.stringify([nonce, exp, ...BOUND_PARAMS.map((k) => String(params[k] ?? ""))]));
}

export function issueCsrf(nonce, params, nowS = Math.floor(Date.now() / 1000)) {
  const exp = nowS + CSRF_TTL_S;
  return `${exp}.${csrfMac(nonce, exp, params)}`;
}

export function verifyCsrf(nonce, token, params, nowS = Math.floor(Date.now() / 1000)) {
  if (!nonce || typeof token !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) return false;
  const m = token.match(/^(\d{1,12})\.([0-9a-f]{64})$/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < nowS) return false;
  return safeEqual(m[2], csrfMac(nonce, exp, params));
}

/** Render the consent form with a CSRF token bound to `nonce` and the request params. */
function sendConsent(res, status, params, nonce, error) {
  htmlHeaders(res, status, consentCsp(params.redirect_uri));
  res.end(renderConsent({ params: { ...params, csrf_token: issueCsrf(nonce, params) }, error }));
}

export const config = { runtime: "nodejs" };

function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function renderConsent({ params, error }) {
  const errorBlock = error ? `<div class="err">${htmlEscape(error)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect LogMem</title>
<style>
:root{--bg:#faf8f3;--ink:#1a1a1a;--accent:#c8553d;--mut:#666;--card:#fff;--bord:#e5e1d6}
*{box-sizing:border-box}
body{margin:0;font-family:Georgia,'Times New Roman',serif;background:var(--bg);color:var(--ink);line-height:1.5;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{max-width:480px;width:100%;background:var(--card);border:1px solid var(--bord);border-radius:6px;padding:32px}
h1{margin:0 0 6px;font-size:24px;font-weight:400;letter-spacing:-.01em}
.sub{color:var(--mut);font-size:14px;margin-bottom:20px}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:14px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--bord);border-radius:4px;font-family:'SF Mono',Menlo,monospace;font-size:13px;background:#fefdf9}
input:focus{outline:none;border-color:var(--accent)}
.client{padding:12px 14px;background:#f5f1e6;border-radius:4px;margin-bottom:18px;font-size:13px}
.client b{font-weight:600}
button{width:100%;padding:11px;background:var(--ink);color:#faf8f3;border:none;border-radius:4px;font-family:inherit;font-size:14px;cursor:pointer;margin-top:18px}
button:hover{background:var(--accent)}
.deny{background:transparent;color:var(--mut);font-size:12px;margin-top:6px;text-decoration:underline;border:none;cursor:pointer;padding:8px}
.err{padding:10px 12px;background:#fdeae6;border-left:3px solid var(--accent);color:var(--accent);font-size:13px;margin-bottom:14px;border-radius:3px}
.foot{font-size:11px;color:var(--mut);margin-top:18px;border-top:1px solid var(--bord);padding-top:14px}
.scope{display:inline-block;padding:2px 8px;background:#f5f1e6;border-radius:10px;font-size:11px;font-family:monospace;margin-right:4px}
.backends{display:flex;gap:16px;margin-top:2px}
.radio{display:flex;align-items:center;gap:6px;font-size:13px;text-transform:none;letter-spacing:0;color:var(--ink);margin:0}
.hint{font-size:11px;color:var(--mut);margin-top:4px}
</style>
</head>
<body>
<form class="card" method="POST" action="/api/oauth/authorize" autocomplete="off">
  <h1>Connect LogMem</h1>
  <div class="sub">Give this app access to one LogMem space.</div>
  ${errorBlock}
  <div class="client">
    <b>${htmlEscape(params.client_name || params.client_id)}</b> wants access<br>
    <span class="scope">scope: ${htmlEscape(normalizeScope(params.scope))}</span>
    <span class="scope">redirect: ${htmlEscape(new URL(params.redirect_uri).host)}</span>
  </div>

  <label for="space">Space</label>
  <input type="text" id="space" name="space" placeholder="your-space" value="${htmlEscape(params.space || "")}">
  <div class="hint">This connection can only read and write this space.</div>

  <label>Redis backend</label>
  <div class="backends">
    <label class="radio"><input type="radio" name="backend" value="redis" ${params.backend === "upstash" ? "" : "checked"}> Redis (rediss://, the official Redis server)</label>
    <label class="radio"><input type="radio" name="backend" value="upstash" ${params.backend === "upstash" ? "checked" : ""}> HTTP Redis REST bridge</label>
  </div>

  <div id="fields-upstash">
    <label for="upstash_url">HTTP Redis REST URL</label>
    <input type="text" id="upstash_url" name="upstash_url" placeholder="https://your-redis-rest-host/exec" value="${htmlEscape(params.upstash_url_prefill || "")}">
    <div class="hint">For hosts that only allow HTTP. Use the bridge's exec URL, with no trailing slash.</div>

    <label for="upstash_token">HTTP Redis REST token</label>
    <input type="password" id="upstash_token" name="upstash_token" placeholder="REST token">
  </div>

  <div id="fields-redis" style="display:none">
    <label for="redis_uri">Redis URI</label>
    <input type="password" id="redis_uri" name="redis_uri" placeholder="rediss://:password@host:6379/0" value="${htmlEscape(params.redis_uri_prefill || "")}">
    <div class="hint">redis:// or rediss:// — include the password in the URI. The server must be reachable from the public internet.</div>
  </div>

  ${[...BOUND_PARAMS,"csrf_token"].map(k=>`<input type="hidden" name="${k}" value="${htmlEscape(params[k]||"")}">`).join("")}

  <script>
  (function(){
    var up=document.getElementById("fields-upstash"),rd=document.getElementById("fields-redis");
    function sync(){
      var v=document.querySelector('input[name="backend"]:checked').value;
      up.style.display=v==="upstash"?"":"none";
      rd.style.display=v==="redis"?"":"none";
    }
    document.querySelectorAll('input[name="backend"]').forEach(function(r){r.addEventListener("change",sync)});
    sync();
  })();
  </script>

  <button type="submit" name="action" value="approve">Authorize</button>
  <button type="submit" name="action" value="deny" class="deny">Deny</button>

  <div class="foot">Your Redis credentials are stored on this server encrypted at rest, bound to this access token, and dropped when the token expires. Rotate your Redis password or REST token any time to revoke out-of-band.</div>
</form>
</body>
</html>`;
}

function renderErrorPage(title, detail) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect LogMem</title>
<style>body{margin:0;font-family:Georgia,serif;background:#faf8f3;color:#1a1a1a;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{max-width:480px;background:#fff;border:1px solid #e5e1d6;border-radius:6px;padding:32px}h1{margin:0 0 8px;font-size:22px;font-weight:400}p{color:#666;font-size:14px}</style>
</head><body><div class="card"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(detail)}</p></div></body></html>`;
}

/** 400/503 page for errors that must not redirect (unknown client, bad redirect_uri, server config). */
function sendErrorPage(res, status, title, detail) {
  htmlHeaders(res, status, ERROR_CSP);
  res.end(renderErrorPage(title, detail));
}

// CSP for the callback hop page: no scripts, no forms, no subresources.
export const HOP_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Send the browser to the client's redirect_uri with `params`, state, and the
 * RFC 9207 issuer.
 *
 * A GET gets a plain 302. A POST (the consent form) gets a 200 page that moves
 * on with a meta refresh. Chromium checks the consent page's form-action on
 * every redirect of a form navigation, including the client's own redirects
 * after our hop. Gemini's callback (oauth-redirect.googleusercontent.com)
 * redirects again to another Google origin, so a 302 here was blocked and
 * "Allow" did nothing. A meta refresh is a new navigation that form-action
 * does not govern.
 */
function redirectTo(res, req, redirect_uri, params, state) {
  const u = new URL(redirect_uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuerFor(req));
  const target = u.toString();
  if (String(req?.method || "GET").toUpperCase() !== "POST") {
    res.statusCode = 302;
    res.setHeader("Location", target);
    return res.end();
  }
  const t = htmlEscape(target);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", HOP_CSP);
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${t}">
<title>Returning to the app</title>
<style>body{margin:0;font-family:Georgia,serif;background:#faf8f3;color:#1a1a1a;min-height:100vh;display:grid;place-items:center;padding:24px}a{color:#0e6863}</style>
</head><body><p data-callback="${t}">Returning to the app. <a href="${t}">Continue</a> if nothing happens.</p></body></html>`);
}

function redirectError(res, req, redirect_uri, error, error_description, state) {
  redirectTo(res, req, redirect_uri, { error, error_description }, state);
}

/**
 * Two phases. Phase 1 (client_id + redirect_uri) failures set `noRedirect`:
 * the caller must render a 400 page. Only after phase 1 passes is the
 * redirect_uri trusted enough to carry phase-2 errors back via 302.
 */
export async function validateAuthRequest(query, req) {
  const client_id = typeof query.client_id === "string" ? query.client_id : "";
  const redirect_uri = typeof query.redirect_uri === "string" ? query.redirect_uri : "";
  if (!client_id) return { noRedirect: true, error: "invalid_request", description: "missing client_id" };
  if (!redirect_uri) return { noRedirect: true, error: "invalid_request", description: "missing redirect_uri" };

  const client = await getClient(client_id);
  if (!client) return { noRedirect: true, error: "invalid_client", description: "unknown client_id" };
  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirect_uri)) {
    return { noRedirect: true, error: "invalid_redirect_uri", description: "redirect_uri not registered for client" };
  }

  for (const k of ["response_type", "code_challenge", "code_challenge_method"]) {
    if (!query[k]) return { client, error: "invalid_request", description: `missing ${k}` };
  }
  if (query.response_type !== "code") return { client, error: "unsupported_response_type", description: "only 'code' supported" };
  if (query.code_challenge_method !== "S256") return { client, error: "invalid_request", description: "code_challenge_method must be S256" };
  // RFC 7636 4.2: BASE64URL(SHA256(verifier)) is 43 chars; allow the spec's 43-128 range.
  if (typeof query.code_challenge !== "string" || !CODE_CHALLENGE_RE.test(query.code_challenge)) {
    return { client, error: "invalid_request", description: "code_challenge must be 43-128 base64url characters" };
  }
  const bound = bindResource(query.resource, req);
  if (bound.error) return { client, error: "invalid_target", description: "unknown resource" };
  return { client, resource: bound.resource, scope: normalizeScope(query.scope || client.scope) };
}

function rejectRequest(res, req, v, source) {
  if (v.noRedirect) {
    return sendErrorPage(res, 400, "This app's sign-in request is invalid", `${v.error}: ${v.description}. Nothing was shared.`);
  }
  return redirectError(res, req, source.redirect_uri, v.error, v.description, source.state);
}

// ───── Managed mode (spec 2026-10-19 one-click connect, 4.3) ─────
// LOGMEM_MANAGED=1: Clerk says who the person is, LogMem makes or finds their
// space, and the consent page is one button. The page above (Redis URL and
// token) stays for self-hosted mode.

export const managedMode = (env = process.env) => env.LOGMEM_MANAGED === "1";

let managedDeps = null;
/** Tests: { session(req, url), redis(), waitlistRedis() }. Pass null to restore. */
export function __setManagedDepsForTests(d) {
  managedDeps = d;
}
function deps() {
  if (managedDeps) return managedDeps;
  return {
    ready: () => clerkConfigured(),
    session: (req, url) => clerkSession(req, { url }),
    redis: () => customerRedis(),
    waitlistRedis: () => serverRedis(),
  };
}

/** The default agent id for an app: a slug of its registered name, else "app". */
export function defaultAgentFor(clientName) {
  const slug = String(clientName || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  try {
    return checkAgentId(slug || "app");
  } catch {
    return "app";
  }
}

function infoPage(res, status, title, detail) {
  htmlHeaders(res, status, ERROR_CSP);
  res.end(renderErrorPage(title, detail));
}

function renderManagedConsent({ params, appName, agent, email, error, scope }) {
  const verbs = String(scope || "").split(" ").includes(SCOPE_WRITE) ? "read and write" : "read";
  const hidden = [...BOUND_PARAMS, "csrf_token"].map((k) => `<input type="hidden" name="${k}" value="${htmlEscape(params[k] || "")}">`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect LogMem</title>
<style>body{margin:0;font-family:Georgia,serif;background:#faf8f3;color:#1a1a1a;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{max-width:480px;width:100%;background:#fff;border:1px solid #e5e1d6;border-radius:6px;padding:32px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:22px;font-weight:400}p{margin:0;color:#666;font-size:14px}.err{color:#a3261a}
button{font:inherit;font-size:16px;padding:12px 16px;border-radius:4px;border:1px solid #1a1a1a;cursor:pointer}
.go{background:#0e6863;border-color:#0e6863;color:#fff}.no{background:#fff}
details{font-size:13px;color:#666}input[type=text]{width:100%;padding:8px 10px;margin-top:6px;border:1px solid #d3cfc4;border-radius:4px;font-family:'SF Mono',Menlo,monospace}</style>
</head><body><form class="card" method="POST" action="/api/oauth/authorize">
<h1>Connect ${htmlEscape(appName)}</h1>
<p>Signed in as ${htmlEscape(email)}. ${htmlEscape(appName)} will ${verbs} your LogMem memory as the agent <b>${htmlEscape(agent)}</b>.</p>
${error ? `<p class="err" role="alert">${htmlEscape(error)}</p>` : ""}
${hidden}
<button class="go" type="submit" name="action" value="approve">Allow ${htmlEscape(appName)} to use your LogMem memory</button>
<details><summary>Use a different agent name</summary><input type="text" name="agent" placeholder="${htmlEscape(agent)}" maxlength="64" autocomplete="off" spellcheck="false" aria-label="Agent name"></details>
<button class="no" type="submit" name="action" value="deny">Cancel</button>
<p>You can disconnect ${htmlEscape(appName)} at any time from logmem.si/app.</p>
</form></body></html>`;
}

function sendManagedConsent(res, status, params, nonce, extra) {
  htmlHeaders(res, status, consentCsp(params.redirect_uri));
  res.end(renderManagedConsent({ params: { ...params, csrf_token: issueCsrf(nonce, params) }, ...extra }));
}

/** Who is signed in, and their account. Writes the reply itself and returns null when the flow stops here. */
// ─── fleet sign-in (distribution M1) ───────────────────────────────────
// When the browser holds a valid admin session (signed in at logmem.si/app),
// the consent page offers the deploy's own spaces (madez) as well as the
// person's account. The token stores { kind: "fleet", agent } and the space;
// the server's own backend is used at request time, as for an agent key.
// "?account=1" skips this page and connects the person's own account.
export const fleetMode = (req, params) => isAdmin(req) && String(params.account || "") !== "1";

function renderFleetConsent({ params, appName, agent, spaces, error, accountUrl }) {
  const hidden = [...BOUND_PARAMS, "csrf_token"].map((k) => `<input type="hidden" name="${k}" value="${htmlEscape(params[k] || "")}">`).join("");
  const opts = spaces.map((sp) => `<option value="${htmlEscape(sp)}"${sp === params.space ? " selected" : ""}>${htmlEscape(sp)}</option>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect LogMem</title>
<style>body{margin:0;font-family:Georgia,serif;background:#faf8f3;color:#1a1a1a;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{max-width:480px;width:100%;background:#fff;border:1px solid #e5e1d6;border-radius:6px;padding:32px;display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:22px;font-weight:400}p{margin:0;color:#666;font-size:14px}.err{color:#a3261a}
label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666}
select,input[type=text]{width:100%;box-sizing:border-box;padding:8px 10px;margin-top:6px;border:1px solid #d3cfc4;border-radius:4px;font-family:'SF Mono',Menlo,monospace;font-size:14px}
button{font:inherit;font-size:16px;padding:12px 16px;border-radius:4px;border:1px solid #1a1a1a;cursor:pointer}
.go{background:#0e6863;border-color:#0e6863;color:#fff}.no{background:#fff}a{color:#0e6863;font-size:13px}</style>
</head><body><form class="card" method="POST" action="/api/oauth/authorize">
<h1>Connect ${htmlEscape(appName)} to the fleet</h1>
<p>You are signed in as the LogMem admin. ${htmlEscape(appName)} will read and write one fleet space as one agent.</p>
${error ? `<p class="err" role="alert">${htmlEscape(error)}</p>` : ""}
${hidden}<input type="hidden" name="fleet" value="1">
<div><label for="space">Space</label><select id="space" name="space">${opts}</select></div>
<div><label for="agent">Agent name</label><input type="text" id="agent" name="agent" value="${htmlEscape(agent)}" maxlength="64" autocomplete="off" spellcheck="false"></div>
<button class="go" type="submit" name="action" value="approve">Allow ${htmlEscape(appName)}</button>
<button class="no" type="submit" name="action" value="deny">Cancel</button>
${accountUrl ? `<a href="${htmlEscape(accountUrl)}">Connect my own LogMem account instead</a>` : ""}
<p>Disconnect it any time from logmem.si/app.</p>
</form></body></html>`;
}

function sendFleetConsent(res, status, params, nonce, extra) {
  htmlHeaders(res, status, consentCsp(params.redirect_uri));
  res.end(renderFleetConsent({ params: { ...params, csrf_token: issueCsrf(nonce, params) }, ...extra }));
}

function accountUrlFor(query) {
  const q = new URLSearchParams();
  for (const k of BOUND_PARAMS) if (query[k] != null && query[k] !== "") q.set(k, String(query[k]));
  q.set("account", "1");
  return `/api/oauth/authorize?${q}`;
}

async function fleetApprove(req, res, body, v, nonce) {
  if (!isAdmin(req)) {
    return sendErrorPage(res, 401, "Your admin sign-in expired", "Sign in again at logmem.si/app, then connect again from the app. Nothing was shared.");
  }
  const appName = v.client.client_name || "This app";
  const spaces = keySpaces();
  const again = (error) => sendFleetConsent(res, 400, { ...body, client_name: v.client.client_name }, nonce, { appName, agent: String(body.agent || ""), spaces, error, accountUrl: accountUrlFor(body) });
  const space = String(body.space || "").trim();
  if (!spaces.includes(space)) return again("Pick one of the listed spaces.");
  let agent;
  try {
    agent = checkAgentId(String(body.agent || "").trim().toLowerCase(), "Agent name");
  } catch (e) {
    return again(e.message);
  }
  const code = await saveAuthCode({
    client_id: body.client_id,
    redirect_uri: body.redirect_uri,
    code_challenge: body.code_challenge,
    code_challenge_method: body.code_challenge_method,
    scope: v.scope,
    resource: v.resource,
    upstash_url: null,
    upstash_token: null,
    backend: { kind: "fleet", agent },
    sub: "admin:fleet",
    space,
  });
  redirectTo(res, req, body.redirect_uri, { code }, body.state);
}

async function managedAccount(req, res, url, { onSignedOut }) {
  const d = deps();
  let redis;
  try {
    if (d.ready && !d.ready()) throw new Error("clerk not configured");
    redis = d.redis();
  } catch {
    infoPage(res, 503, "Connections are temporarily unavailable", "This server is not set up for LogMem accounts yet. Nothing was shared.");
    return null;
  }
  const s = await d.session(req, url);
  if (s.status === "handshake") {
    const cookies = [];
    for (const [k, v] of s.headers || []) {
      if (k.toLowerCase() === "set-cookie") cookies.push(v);
      else res.setHeader(k, v);
    }
    if (cookies.length) res.setHeader("Set-Cookie", cookies);
    res.statusCode = 307;
    res.end();
    return null;
  }
  if (s.status !== "signed-in") {
    onSignedOut(s);
    return null;
  }
  const acct = await accountFor({ clerkUserId: s.userId, email: s.email }, { redis, waitlistRedis: d.waitlistRedis ? d.waitlistRedis() : null });
  if (acct.waitlist) {
    infoPage(res, 200, "You're on the list", "LogMem is in a private beta. We'll email your invite. Nothing was shared.");
    return null;
  }
  if (acct.status !== "active") {
    infoPage(res, 403, "This LogMem account is paused", "Nothing was shared. Contact LogMem support to turn it back on.");
    return null;
  }
  return { session: s, acct };
}

async function managedGet(req, res, query, v) {
  const url = `https://${req.headers.host}${req.url}`;
  const got = await managedAccount(req, res, url, {
    onSignedOut: (s) => {
      res.statusCode = 302;
      res.setHeader("Location", s.signInUrl);
      res.end();
    },
  });
  if (!got) return;
  const params = { ...query, client_name: v.client.client_name };
  const nonce = randomToken(16);
  res.setHeader("Set-Cookie", `${CSRF_COOKIE}=${nonce}; Path=/api/oauth/authorize; Max-Age=${CSRF_TTL_S}; HttpOnly; Secure; SameSite=Strict`);
  const appName = v.client.client_name || "This app";
  return sendManagedConsent(res, 200, params, nonce, { appName, agent: defaultAgentFor(v.client.client_name), email: got.session.email, scope: v.scope });
}

async function managedApprove(req, res, body, v) {
  const url = `https://${req.headers.host}/api/oauth/authorize`;
  const got = await managedAccount(req, res, url, {
    onSignedOut: () => infoPage(res, 401, "Your sign-in expired", "Go back to the app and connect again. Nothing was shared."),
  });
  if (!got) return;
  const appName = v.client.client_name || "This app";
  let agent = defaultAgentFor(v.client.client_name);
  const wanted = String(body.agent || "").trim().toLowerCase();
  if (wanted) {
    try {
      agent = checkAgentId(wanted);
    } catch (e) {
      const nonce = readCookie(req, CSRF_COOKIE);
      return sendManagedConsent(res, 400, { ...body, client_name: v.client.client_name }, nonce, { appName, agent: defaultAgentFor(v.client.client_name), email: got.session.email, scope: v.scope, error: `Agent name: ${e.message}` });
    }
  }
  const code = await saveAuthCode({
    client_id: body.client_id,
    redirect_uri: body.redirect_uri,
    code_challenge: body.code_challenge,
    code_challenge_method: body.code_challenge_method,
    scope: v.scope,
    resource: v.resource,
    upstash_url: null,
    upstash_token: null,
    backend: { kind: "managed", tenant: got.acct.tenant, agent },
    sub: `clerk:${got.session.userId}`,
    space: got.acct.space,
  });
  redirectTo(res, req, body.redirect_uri, { code }, body.state);
}

// No CORS headers: /authorize is a top-level browser navigation, never a
// cross-origin fetch.
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const query = Object.fromEntries(url.searchParams);
      const v = await validateAuthRequest(query, req);
      if (v.error) return rejectRequest(res, req, v, query);
      if (fleetMode(req, query)) {
        const nonce = randomToken(16);
        res.setHeader("Set-Cookie", `${CSRF_COOKIE}=${nonce}; Path=/api/oauth/authorize; Max-Age=${CSRF_TTL_S}; HttpOnly; Secure; SameSite=Strict`);
        const spaces = keySpaces();
        return sendFleetConsent(res, 200, { ...query, client_name: v.client.client_name, space: spaces[0] }, nonce, { appName: v.client.client_name || "This app", agent: defaultAgentFor(v.client.client_name), spaces, accountUrl: accountUrlFor(query) });
      }
      if (managedMode()) return await managedGet(req, res, query, v);
      const params = { ...query, client_name: v.client.client_name };
      const nonce = randomToken(16);
      res.setHeader("Set-Cookie", `${CSRF_COOKIE}=${nonce}; Path=/api/oauth/authorize; Max-Age=${CSRF_TTL_S}; HttpOnly; Secure; SameSite=Strict`);
      return sendConsent(res, 200, params, nonce);
    }

    if (req.method !== "POST") {
      res.setHeader("Content-Security-Policy", ERROR_CSP);
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const body = req.body || {};
    const v = await validateAuthRequest(body, req);
    if (v.error) return rejectRequest(res, req, v, body);

    const nonce = readCookie(req, CSRF_COOKIE);
    if (!verifyCsrf(nonce, body.csrf_token, body)) {
      return sendErrorPage(res, 403, "This consent form expired or was not opened here", "Go back to the app and start connecting again. Nothing was shared.");
    }

    if (body.action === "deny") {
      return redirectError(res, req, body.redirect_uri, "access_denied", "user denied consent", body.state);
    }

    // Production without LOGMEM_OAUTH_KEK: refuse before touching user creds.
    try {
      assertKekReady();
    } catch {
      return sendErrorPage(res, 503, "Connections are temporarily unavailable", "This server is not configured to store credentials securely yet. Nothing was saved.");
    }

    if (String(body.fleet || "") === "1") return await fleetApprove(req, res, body, v, nonce);
    if (managedMode()) return await managedApprove(req, res, body, v);

    const space = String(body.space || "").trim().toLowerCase();
    try {
      validateKeySegments(space);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(space)) throw new Error("letters, numbers, - and _ only");
    } catch (e) {
      const params = { ...body, client_name: v.client.client_name };
      return sendConsent(res, 400, params, nonce, `Space: ${e.message}`);
    }

    const backendKind = body.backend === "redis" ? "redis" : "upstash";
    const fail = (error, extra = {}) => {
      const params = { ...body, client_name: v.client.client_name, ...extra };
      sendConsent(res, 400, params, nonce, error);
    };

    let backend;
    let sub;
    let upstash_url = null;
    let upstash_token = null;

    if (backendKind === "redis") {
      const redis_uri = String(body.redis_uri || "").trim();
      if (!redis_uri) return fail("Redis URI is required.");
      if (!/^rediss?:\/\/\S+$/i.test(redis_uri)) {
        return fail("Redis URI must start with rediss:// (redis:// only where plaintext is enabled)");
      }
      let host;
      try {
        host = new URL(redis_uri).hostname;
      } catch {
        return fail("Redis URI is not a valid URI.");
      }
      // SSRF guard, then probe before issuing a code so the user gets feedback.
      try {
        await assertPublicTarget(redis_uri);
      } catch (e) {
        console.warn(`[oauth/authorize] redis target refused: ${e?.reason || e?.name}`);
        return fail(`${CONNECT_FAILED}. Use a rediss:// URI on a public host and port 6379/6380.`);
      }
      try {
        const { probeNativeRedis } = await import("../../src/lib/redis-native.mjs");
        await probeNativeRedis(redis_uri);
      } catch {
        return fail(`${CONNECT_FAILED}.`);
      }
      backend = { kind: "redis", uri: redis_uri };
      sub = `redis:${host}`;
    } else {
      upstash_url = String(body.upstash_url || "").trim();
      upstash_token = String(body.upstash_token || "").trim();
      if (!upstash_url || !upstash_token) {
        return fail("Both HTTP Redis REST URL and token are required.", { upstash_url_prefill: upstash_url });
      }
      let parsed;
      try {
        parsed = new URL(upstash_url);
      } catch {
        return fail("REST URL is not a valid URL.", { upstash_url_prefill: upstash_url });
      }
      if (parsed.protocol !== "https:") {
        return fail("REST URL must be https://", { upstash_url_prefill: upstash_url });
      }
      // SSRF guard, then probe creds before issuing a code. The probe never
      // follows redirects (a 30x could point at an internal host) and its
      // error body is never shown.
      try {
        await assertPublicTarget(restEndpoint(upstash_url));
      } catch (e) {
        console.warn(`[oauth/authorize] rest target refused: ${e?.reason || e?.name}`);
        return fail(`${CONNECT_FAILED}. Use an https:// URL on a public host.`, { upstash_url_prefill: upstash_url });
      }
      try {
        const probe = await fetch(restEndpoint(upstash_url), {
          method: "POST",
          headers: { Authorization: `Bearer ${upstash_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(["PING"]),
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!probe.ok) throw new Error("probe not ok");
        const j = await probe.json();
        if (j.error || j.result !== "PONG") throw new Error("probe not PONG");
      } catch {
        return fail(`${CONNECT_FAILED}.`, { upstash_url_prefill: upstash_url });
      }
      upstash_url = restEndpoint(upstash_url);
      backend = { kind: "upstash", url: upstash_url, token: upstash_token };
      sub = `rest:${parsed.hostname}`;
    }

    let code;
    try {
      code = await saveAuthCode({
        client_id: body.client_id,
        redirect_uri: body.redirect_uri,
        code_challenge: body.code_challenge,
        code_challenge_method: body.code_challenge_method,
        scope: v.scope,
        resource: v.resource,
        upstash_url,
        upstash_token,
        backend,
        sub,
        space,
      });
    } catch (e) {
      if (e && e.status === 503) {
        return sendErrorPage(res, 503, "Connections are temporarily unavailable", "This server is not configured to store credentials securely yet. Nothing was saved.");
      }
      throw e;
    }

    redirectTo(res, req, body.redirect_uri, { code }, body.state);
  } catch (e) {
    console.error(`[oauth/authorize] ${e?.name || "Error"}`);
    if (!res.headersSent) sendErrorPage(res, e && e.status === 503 ? 503 : 500, "Something went wrong", "Please try connecting again.");
  }
}
