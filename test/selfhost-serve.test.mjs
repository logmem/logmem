// selfhost-serve.test.mjs — the bundle's HTTP entry serves the logmem.si
// surface without Vercel: static first, then api routes, then rewrites,
// with vercel.json's security headers on every path.
//
// Hermetic: the backend is a stub that speaks the REST shape, the key store
// uses storage.mjs's test seam, and the listener binds an ephemeral port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { __setRedisForTests } from "../api/oauth/_lib/storage.mjs";
import { createListener, headersFor, rewriteFor, buildApiRoutes, DEFAULT_PORT } from "../selfhost/serve.mjs";

const SPACE = "selfhost-test";
const ADMIN_PW = "selfhost-test-admin-pw";
let server;
let backend;
let base;
const savedEnv = {};

/** A stub that answers the Upstash REST shape: PING -> PONG, GET -> null. */
function stubBackend() {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let cmd = [];
      try { cmd = JSON.parse(raw); } catch { /* not json */ }
      const result = Array.isArray(cmd) && cmd[0] === "GET" ? null : Array.isArray(cmd) && cmd[0] === "PING" ? "PONG" : "OK";
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
}

async function j(path, opts = {}) {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
}

before(async () => {
  backend = stubBackend();
  await new Promise((r) => backend.listen(0, "127.0.0.1", r));
  for (const [k, v] of Object.entries({
    LOGMEM_ADMIN_PASSWORD: ADMIN_PW,
    LOGMEM_SPACE: SPACE,
    LOGMEM_SPACES: SPACE,
    LOGMEM_VIEW_SPACES: SPACE,
    // descriptorFromEnv wants the REST pair for an HTTP backend (the stub),
    // not LOGMEM_REDIS_URI, which is a native redis:// endpoint.
    LOGMEM_REST_URL: `http://127.0.0.1:${backend.address().port}`,
    LOGMEM_REST_TOKEN: "stub",
    LOGMEM_OAUTH_ALLOW_INSECURE: "1",
  })) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  delete savedEnv.VERCEL_ENV; // keep insecureAllowed honest for the local bundle
  delete process.env.VERCEL_ENV;
  __setRedisForTests(createMemoryRedis());
  server = http.createServer(createListener({ log: () => {} }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  __setRedisForTests(null);
  // Keep-alive sockets would hold the process open after close().
  server?.closeAllConnections?.();
  server?.close();
  backend?.closeAllConnections?.();
  backend?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("health answers 200 through the bundle entry, not just on Vercel", async () => {
  const r = await j("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.space, undefined, "health never leaks space data");
});

test("static wins first: the homepage and cleanUrls both serve", async () => {
  const home = await j("/");
  assert.equal(home.status, 200);
  assert.match(String(home.body), /<html/i, "index.html is served");
  const keys = await j("/keys");
  assert.equal(keys.status, 200, "/keys resolves keys.html through cleanUrls");
  assert.match(keys.headers.get("content-type") || "", /text\/html/);
});

test("vercel.json security headers reach the browser on every path", async () => {
  const app = await j("/app");
  assert.equal(app.status, 200);
  assert.equal(app.headers.get("x-content-type-options"), "nosniff");
  assert.match(app.headers.get("content-security-policy") || "", /default-src 'self'/, "the strict CSP lands on /app");
  const signin = await j("/sign-in");
  assert.ok([200, 401, 503].includes(signin.status), `sign-in routes: ${signin.status}`);
  const csp = signin.headers.get("content-security-policy") || "";
  assert.ok(!csp.includes("accounts.dev"), "the sign-in exclusion keeps the strict CSP off Clerk's door");
});

test("rewrites carry the surface: /mcp reaches the MCP route, /api/pulse reaches work", async () => {
  const mcp = await j("/mcp");
  // PR 232: an unauthenticated MCP request gets the 401 challenge, not a 404.
  // Either way the rewrite reached the handler, which a 404 would not.
  assert.equal(mcp.status, 401, "GET /mcp rewrites to /api/mcp (the PR 232 challenge)");
  assert.match(mcp.headers.get("www-authenticate") || "", /logmem/, "the challenge carries the resource metadata");
  const pulse = await j("/api/pulse");
  assert.ok([200, 401, 403].includes(pulse.status), `pulse rewrites to work: ${pulse.status}`);
});

test("admin login and agent-key mint work through the bundle entry", async () => {
  const login = await j("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: ADMIN_PW }),
  });
  assert.equal(login.status, 200, "admin password sign-in");
  assert.equal(login.body.ok, true);
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  assert.match(cookie, /lm_admin/, "the admin cookie is set");

  const mint = await j("/api/agent-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-LogMem-Intent": "agent-keys", cookie },
    body: JSON.stringify({ space: process.env.LOGMEM_SPACE, agent: "bundle-probe", label: "bundle test", scope: "read" }),
  });
  assert.equal(mint.status, 201, `mint through the bundle: ${JSON.stringify(mint.body)}`);
  assert.equal(mint.body.scope, "read", "the scope field survives the bundle path");
  assert.match(mint.body.key, /^lmk_/, "key shown once");
  assert.ok(!JSON.stringify(mint.body).includes(process.env.LOGMEM_ADMIN_PASSWORD), "no admin password in the reply");
});

test("unknown paths 404 and traversal never escapes public/", async () => {
  const missing = await j("/no/such/page");
  assert.equal(missing.status, 404);
  // %2e%2e survives fetch's URL normalization, so this exercises the guard.
  const escape = await j("/%2e%2e/%2e%2e/package.json");
  assert.equal(escape.status, 404, `traversal refused: ${escape.status}`);
  const api404 = await j("/api/nope", { headers: { Accept: "application/json" } });
  assert.equal(api404.status, 404);
  assert.deepEqual(api404.body, { error: "not found" });
});

test("the router table covers the surface and skips private dirs", () => {
  const routes = buildApiRoutes();
  const paths = routes.map((r) => r.path);
  for (const want of ["/api/health", "/api/mcp", "/api/login", "/api/agent-keys", "/api/view", "/api/workspaces", "/api/spaces", "/api/cron/reconcile"]) {
    assert.ok(paths.includes(want), `missing route: ${want}`);
  }
  assert.ok(paths.includes("/api/inbox/[agent]"), "dynamic segments become routes (file-form path)");
  const inbox = routes.find((r) => r.path === "/api/inbox/[agent]");
  assert.deepEqual(inbox.params, ["agent"], "the param name is kept");
  assert.ok(!paths.some((p) => p.includes("/_lib")), "api/oauth/_lib is not a route");
});

test("rewriteFor substitutes params and merges the query", () => {
  const rules = [
    { source: "/mcp", destination: "/api/mcp?_lm_path=mcp" },
    { source: "/api/pulse", destination: "/api/work?op=pulse" },
    { source: "/.well-known/oauth-protected-resource/:path*", destination: "/.well-known/oauth-protected-resource?path=:path*" },
  ];
  const a = rewriteFor("/mcp", {}, rules);
  assert.equal(a.path, "/api/mcp");
  assert.equal(a.query._lm_path, "mcp");
  const b = rewriteFor("/api/pulse", { space: "madez" }, rules);
  assert.equal(b.path, "/api/work");
  assert.equal(b.query.op, "pulse");
  assert.equal(b.query.space, "madez", "existing query survives the rewrite");
  const c = rewriteFor("/.well-known/oauth-protected-resource/api/mcp", {}, rules);
  assert.equal(c.query.path, "api/mcp", ":path* binds the capture into the destination");
  assert.equal(rewriteFor("/nothing", {}, rules), null);
});

test("headersFor applies the exact and grouped vercel.json rules", () => {
  const rules = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")).headers;
  const app = headersFor("/app", rules);
  assert.match(app["Content-Security-Policy"], /accounts\.dev/, "the app door allows Clerk");
  const plain = headersFor("/keys", rules);
  assert.match(plain["Content-Security-Policy"], /default-src 'self'/);
  const signIn = headersFor("/sign-in", rules);
  assert.ok(!signIn["Content-Security-Policy"]?.includes("accounts.dev"), "sign-in is excluded from the strict rule");
  assert.equal(headersFor("/llm.txt", rules)["X-Content-Type-Options"], "nosniff", "the catch-all rule matches");
  assert.equal(DEFAULT_PORT, 3899, "the documented default port");
});