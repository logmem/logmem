import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { issueCookie, issueIdentityCookie, adminIdentity, isAdmin, AdminSecretMissingError } from "../src/http/admin-auth.mjs";
import { createLoginHandler } from "../api/login.mjs";
import { createHandler as adminUsersHandler } from "../api/admin-users.mjs";
import { setRole, getRole, isSuspended, isSuspendedSafe, activeRole, requireAdminAuth, BREAK_GLASS, SuspensionStoreError } from "../src/http/admin-roles.mjs";
import { createHandler as invitesHandler } from "../api/invites.mjs";
import { createHandler as agentKeysHandler } from "../api/agent-keys.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";

const ENV = { LOGMEM_ADMIN_PASSWORD: "pw", LOGMEM_CUSTOMER_DASHBOARD: "1" };
const ADMIN_USER = "user_3LD8wM7l1wXcWoRsjGPwLPVg4nw";
const cookieOf = (setCookie) => String(setCookie).split(";")[0];

test("identity cookie: verifies to the account id, legacy stays break-glass", () => {
  const idc = cookieOf(issueIdentityCookie(ENV, ADMIN_USER));
  const req = mockReq({ url: "/api/admin-users", headers: { cookie: idc } });
  assert.equal(adminIdentity(req, ENV), ADMIN_USER);
  assert.equal(isAdmin(req, ENV), true, "identity cookie is an admin cookie");
  const legacy = cookieOf(issueCookie(ENV));
  const req2 = mockReq({ url: "/api/admin-users", headers: { cookie: legacy } });
  assert.equal(adminIdentity(req2, ENV), "break-glass", "legacy cookie keeps working with honest attribution");
  assert.equal(isAdmin(req2, ENV), true, "legacy still admin");
});

test("identity cookie: tamper and expiry fail closed", () => {
  const idc = cookieOf(issueIdentityCookie(ENV, ADMIN_USER));
  const [exp, id, mac] = idc.slice("lm_admin=".length).split(".");
  const tampered = `lm_admin=${exp}.user_attacker0001.${mac}`;
  assert.equal(adminIdentity(mockReq({ url: "/x", headers: { cookie: tampered } }), ENV), null);
  const expired = `lm_admin=${Math.floor(Date.now() / 1000) - 10}.${id}.${mac}`;
  assert.equal(adminIdentity(mockReq({ url: "/x", headers: { cookie: expired } }), ENV), null);
  assert.equal(adminIdentity(mockReq({ url: "/x", headers: { cookie: "lm_admin=a.b.c.d" } }), ENV), null);
});

test("login: password path issues the legacy break-glass cookie unchanged", async () => {
  const handler = createLoginHandler({ env: ENV, session: async () => ({ status: "signed-out" }), roleLookup: async () => null, redis: createMemoryRedis() });
  const res = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/login", body: { password: "pw" } }), res);
  assert.equal(res.statusCode, 200, res.body);
  const c = cookieOf(res.getHeader("set-cookie"));
  assert.equal(adminIdentity({ headers: { cookie: c } }, ENV), "break-glass");
  const bad = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/login", body: { password: "nope" } }), bad);
  assert.equal(bad.statusCode, 401, "wrong password still 401");
});

test("login: Clerk session with an admin-surface role issues the identity cookie", async () => {
  const redis = createMemoryRedis();
  const handler = createLoginHandler({
    env: ENV,
    session: async () => ({ status: "signed-in", userId: ADMIN_USER, email: "m@x.com", sessionId: "sess_1" }),
    roleLookup: async () => ({ role: "admin" }),
    redis,
  });
  const res = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/login", body: {} }), res);
  assert.equal(res.statusCode, 200, res.body);
  const c = cookieOf(res.getHeader("set-cookie"));
  assert.equal(adminIdentity({ headers: { cookie: c } }, ENV), ADMIN_USER, "cookie carries the account id");
  const body = JSON.parse(res.body);
  assert.equal(body.role, "admin");

  // role outside the session surface -> refused
  const viewer = createLoginHandler({ env: ENV, session: async () => ({ status: "signed-in", userId: ADMIN_USER }), roleLookup: async () => ({ role: "viewer" }), redis });
  const r2 = mockRes();
  await viewer(mockReq({ method: "POST", url: "/api/login", body: {} }), r2);
  assert.equal(r2.statusCode, 403);

  // signed out -> refused with a hint
  const out = createLoginHandler({ env: ENV, session: async () => ({ status: "signed-out" }), roleLookup: async () => null, redis });
  const r3 = mockRes();
  await out(mockReq({ method: "POST", url: "/api/login", body: {} }), r3);
  assert.equal(r3.statusCode, 401);
});

test("admin route attributes actions to the cookie identity, not break-glass", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  await setRole({ actorId: "break-glass", userId: ADMIN_USER, role: "admin", redis });
  const idc = cookieOf(issueIdentityCookie(ENV, ADMIN_USER));
  const res = mockRes();
  await handler(mockReq({
    method: "POST", url: "/api/admin-users",
    headers: { cookie: idc, "x-logmem-intent": "admin-users", origin: "https://logmem.si", host: "logmem.si" },
    body: { action: "set-role", userId: "user_someone0000001", role: "billing" },
  }), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await getRole("user_someone0000001", redis)).role, "billing");
  const trail = (await redis("ZRANGE", "lm:admin:audit", 0, -1)).map((x) => JSON.parse(x));
  const entry = trail.find((e) => e.action === "set-role" && e.target === "user_someone0000001");
  assert.ok(entry, "audited");
  assert.equal(entry.by, ADMIN_USER, "attribution is the real account, not break-glass");
  assert.equal((await getRole(ADMIN_USER, redis)).role, "admin");
});

// ---- P1 fix verification (Mikey review 2026-10-31) ----

const headers = (idc, host = "logmem.si") => ({ cookie: idc, "x-logmem-intent": "admin-users", origin: `https://${host}`, host });

test("denial: support and billing cannot set-role, whatever the cookie says", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  await setRole({ actorId: "break-glass", userId: "user_support0000001", role: "support", redis });
  await setRole({ actorId: "break-glass", userId: "user_billing0000001", role: "billing", redis });
  for (const u of ["user_support0000001", "user_billing0000001"]) {
    const res = mockRes();
    await handler(mockReq({
      method: "POST", url: "/api/admin-users", headers: headers(cookieOf(issueIdentityCookie(ENV, u))),
      body: { action: "set-role", userId: "user_victim00000001", role: "admin" },
    }), res);
    assert.equal(res.statusCode, 403, `${u} must not escalate: ${res.body}`);
    assert.equal(JSON.parse(res.body).error, "role_not_authorized");
  }
  assert.equal(await getRole("user_victim00000001", redis).then(r => r.role).catch(() => null), null, "no escalation happened");
  const trail = (await redis("ZRANGE", "lm:admin:audit", 0, -1)).map((x) => JSON.parse(x));
  assert.ok(trail.some((e) => e.action === "authz:denied" && e.attempt === "set-role"), "denied attempt is audited");
});

test("denial: role downgrade bites on the next request, not at cookie expiry", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  await setRole({ actorId: "break-glass", userId: "user_demote00000001", role: "admin", redis });
  const idc = cookieOf(issueIdentityCookie(ENV, "user_demote00000001"));
  const before = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(idc), body: { action: "set-role", userId: "user_x0", role: "viewer" } }), before);
  assert.equal(before.statusCode, 200, "admin can act");
  await setRole({ actorId: "break-glass", userId: "user_demote00000001", role: "viewer", redis });
  const after = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(idc), body: { action: "set-role", userId: "user_x0", role: "admin" } }), after);
  assert.equal(after.statusCode, 403, "same cookie, demoted account: refused");
  assert.equal(JSON.parse(after.body).error, "role_not_authorized");
});

test("denial: suspension bites on the next request; break-glass recovers", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  await setRole({ actorId: "break-glass", userId: "user_suspend0001", role: "admin", redis });
  const idc = cookieOf(issueIdentityCookie(ENV, "user_suspend0001"));
  const res = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(idc), body: { action: "suspend", userId: "user_target0000001", reason: "test" } }), res);
  assert.equal(res.statusCode, 200, res.body);
  // suspend the admin itself; the still-valid cookie dies immediately
  const bg = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(cookieOf(issueCookie(ENV))), body: { action: "suspend", userId: "user_suspend0001", reason: "demotion in progress" } }), bg);
  assert.equal(bg.statusCode, 200, bg.body);
  const dead = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(idc), body: { action: "set-role", userId: "user_target0000001", role: "admin" } }), dead);
  assert.equal(dead.statusCode, 403, "suspended admin refused at once");
  assert.equal(JSON.parse(dead.body).error, "account_suspended");
  // break-glass recovers the account
  const un = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(cookieOf(issueCookie(ENV))), body: { action: "unsuspend", userId: "user_suspend0001" } }), un);
  assert.equal(un.statusCode, 200, un.body);
  const back = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(idc), body: { action: "set-role", userId: "user_target0000001", role: "viewer" } }), back);
  assert.equal(back.statusCode, 200, "restored admin works again");
});

test("denial: identity cookie with no role record is refused, break-glass keeps full access", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  const stranger = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: headers(cookieOf(issueIdentityCookie(ENV, "user_stranger00001"))), body: { action: "set-role", userId: "user_y0", role: "admin" } }), stranger);
  assert.equal(stranger.statusCode, 403, "cookie without a role record: refused");
  assert.equal(JSON.parse(stranger.body).error, "no_role");
  const get = mockRes();
  await handler(mockReq({ method: "GET", url: "/api/admin-users", headers: headers(cookieOf(issueCookie(ENV))) }), get);
  assert.equal(get.statusCode, 200, "break-glass operator keeps the full surface");
});

test("suspension guard: store errors fail closed with 503 backend unavailable (Option A)", async () => {
  const throwing = async () => { throw new Error("NOPERM No permissions to access a key"); };
  await assert.rejects(() => isSuspendedSafe("user_front000001", throwing), (err) => err.status === 503 && err.name === "SuspensionStoreError", "front door fails closed with 503");
  await assert.rejects(() => isSuspended("user_strict00001", throwing), /NOPERM/, "strict read surfaces error");
  await assert.rejects(() => activeRole("user_admin000001", throwing), /NOPERM/, "admin surface fails closed when the store is unavailable");
  const ok = await isSuspendedSafe("user_ok00000001", async () => "0");
  assert.equal(ok, false, "healthy store reads normally through the safe wrapper");
});

test("cookie secret: production requires LOGMEM_ADMIN_SECRET (Option A)", async () => {
  const prodWithoutSecret = { VERCEL_ENV: "production", LOGMEM_ADMIN_PASSWORD: "pw" };
  assert.throws(
    () => adminIdentity(mockReq({ headers: { cookie: "lm_admin=123.456" } }), prodWithoutSecret),
    AdminSecretMissingError,
    "adminIdentity throws AdminSecretMissingError instead of hiding it as 401"
  );
  const prodWithSecret = { VERCEL_ENV: "production", LOGMEM_ADMIN_PASSWORD: "pw", LOGMEM_ADMIN_SECRET: "prod-secret-hex" };
  const cookie = issueIdentityCookie(prodWithSecret, ADMIN_USER);
  const req = mockReq({ headers: { cookie: cookieOf(cookie) } });
  assert.equal(adminIdentity(req, prodWithSecret), ADMIN_USER, "verifies with LOGMEM_ADMIN_SECRET in production");

  // Route mapping: password login with missing secret maps to 503, not 500
  const login = createLoginHandler({ env: prodWithoutSecret });
  const pwRes = mockRes();
  await login(mockReq({ method: "POST", body: { password: "pw" } }), pwRes);
  assert.equal(pwRes.statusCode, 503, "password login returns 503 when admin secret missing in prod");
  assert.equal(JSON.parse(pwRes.body).error, "admin_secret_missing");

  // Route mapping: admin-users returns 503 when admin secret missing in prod
  const adminUsers = adminUsersHandler({ env: prodWithoutSecret });
  const auRes = mockRes();
  await adminUsers(mockReq({ method: "GET", headers: { cookie: "lm_admin=123.456" } }), auRes);
  assert.equal(auRes.statusCode, 503, "admin-users returns 503 when admin secret missing in prod");
  assert.equal(JSON.parse(auRes.body).error, "admin_secret_missing");

  // Route mapping: invites returns 503 when admin secret missing in prod
  const invites = invitesHandler({ env: prodWithoutSecret });
  const invRes = mockRes();
  await invites(mockReq({ method: "GET", headers: { cookie: "lm_admin=123.456" } }), invRes);
  assert.equal(invRes.statusCode, 503, "invites returns 503 when admin secret missing in prod");
  assert.equal(JSON.parse(invRes.body).error, "admin_secret_missing");

  // Route mapping: agent-keys returns 503 when admin secret missing in prod
  const agentKeys = agentKeysHandler({ env: prodWithoutSecret });
  const akRes = mockRes();
  await agentKeys(mockReq({ method: "GET", headers: { cookie: "lm_admin=123.456" } }), akRes);
  assert.equal(akRes.statusCode, 503, "agent-keys returns 503 when admin secret missing in prod");
  assert.equal(JSON.parse(akRes.body).error, "admin_secret_missing");
});

test("break-glass: 1-hour expiration enforced", () => {
  const c = issueCookie(ENV);
  assert.ok(c.includes("Max-Age=3600"), "break glass cookie has 1 hour Max-Age");
  const req = mockReq({ headers: { cookie: cookieOf(c) } });
  assert.equal(adminIdentity(req, ENV), "break-glass");

  // Old legacy cookie with 12 hour remaining lifetime is expired
  const now = Date.now();
  const twelveHoursAhead = Math.floor(now / 1000) + 12 * 3600;
  const oldVal = `${twelveHoursAhead}.dummy`;
  const oldReq = mockReq({ headers: { cookie: `lm_admin=${oldVal}` } });
  assert.equal(adminIdentity(oldReq, ENV), null, "over-long break-glass token is expired");
});

test("requireAdminAuth: live role check and break-glass semantics", async () => {
  const redis = createMemoryRedis();
  // 1. No actorId
  const noActor = await requireAdminAuth(null, redis);
  assert.equal(noActor.ok, false);
  assert.equal(noActor.status, 401);

  // 2. Break-glass requires no redis
  const bg = await requireAdminAuth(BREAK_GLASS, null);
  assert.equal(bg.ok, true);
  assert.equal(bg.breakglass, true);
  assert.equal(bg.role, "operator");

  // 3. User with no redis
  const noRedis = await requireAdminAuth("user_foo1", null);
  assert.equal(noRedis.ok, false);
  assert.equal(noRedis.status, 503);

  // 4. User with no role assigned
  const noRole = await requireAdminAuth("user_norole", redis);
  assert.equal(noRole.ok, false);
  assert.equal(noRole.status, 403);
  assert.equal(noRole.error, "no_role");

  // 5. User with viewer role trying admin action
  await setRole({ actorId: BREAK_GLASS, userId: "user_viewer1", role: "viewer", redis });
  const viewerCheck = await requireAdminAuth("user_viewer1", redis, { allowedRoles: ["admin"] });
  assert.equal(viewerCheck.ok, false);
  assert.equal(viewerCheck.status, 403);
  assert.equal(viewerCheck.error, "role_not_authorized");

  // 6. User with admin role
  await setRole({ actorId: BREAK_GLASS, userId: "user_admin1", role: "admin", redis });
  const adminCheck = await requireAdminAuth("user_admin1", redis, { allowedRoles: ["admin"] });
  assert.equal(adminCheck.ok, true);
  assert.equal(adminCheck.role, "admin");

  // 7. Suspended admin
  await redis("SET", "lm:admin:suspended:user_admin1", JSON.stringify({ at: Date.now(), by: "operator" }));
  const suspCheck = await requireAdminAuth("user_admin1", redis, { allowedRoles: ["admin"] });
  assert.equal(suspCheck.ok, false);
  assert.equal(suspCheck.status, 403);
  assert.equal(suspCheck.error, "account_suspended");

  // 8. Store outage throws 503
  const brokenRedis = async () => { throw new Error("connection reset"); };
  const outageCheck = await requireAdminAuth("user_admin1", brokenRedis, { allowedRoles: ["admin"] });
  assert.equal(outageCheck.ok, false);
  assert.equal(outageCheck.status, 503);
  assert.equal(outageCheck.error, "suspension_store_unavailable");
});

test("admin routes live role checking: invites and agent-keys", async () => {
  const customerDb = createMemoryRedis();
  const deployDb = createMemoryRedis();
  const env = { ...ENV, LOGMEM_CUSTOMER_REDIS_URI: "redis://dummy" };

  const invites = invitesHandler({ env, redis: () => customerDb });
  const agentKeys = agentKeysHandler({ env, redis: () => deployDb, rolesRedis: () => customerDb });

  // Set roles
  await setRole({ actorId: BREAK_GLASS, userId: "user_adm", role: "admin", redis: customerDb });
  await setRole({ actorId: BREAK_GLASS, userId: "user_view", role: "viewer", redis: customerDb });

  const admCookie = cookieOf(issueIdentityCookie(env, "user_adm"));
  const viewCookie = cookieOf(issueIdentityCookie(env, "user_view"));

  // Viewer cannot call invites GET
  const viewRes = mockRes();
  await invites(mockReq({ method: "GET", headers: { cookie: viewCookie } }), viewRes);
  assert.equal(viewRes.statusCode, 403);
  assert.equal(JSON.parse(viewRes.body).error, "role_not_authorized");

  // Admin can call invites GET
  const admRes = mockRes();
  await invites(mockReq({ method: "GET", headers: { cookie: admCookie } }), admRes);
  assert.equal(admRes.statusCode, 200);

  // Viewer cannot call agent-keys GET
  const viewKeysRes = mockRes();
  await agentKeys(mockReq({ method: "GET", headers: { cookie: viewCookie } }), viewKeysRes);
  assert.equal(viewKeysRes.statusCode, 403);
  assert.equal(JSON.parse(viewKeysRes.body).error, "role_not_authorized");

  // Admin can call agent-keys GET
  const admKeysRes = mockRes();
  await agentKeys(mockReq({ method: "GET", headers: { cookie: admCookie } }), admKeysRes);
  assert.equal(admKeysRes.statusCode, 200);

  // Break-glass works even if customer redis is broken for agent-keys
  const bgCookie = cookieOf(issueCookie(env));
  const brokenAgentKeys = agentKeysHandler({
    env,
    redis: () => deployDb,
    rolesRedis: () => { throw new Error("customer redis offline"); }
  });
  const bgRes = mockRes();
  await brokenAgentKeys(mockReq({ method: "GET", headers: { cookie: bgCookie } }), bgRes);
  assert.equal(bgRes.statusCode, 200, "break-glass succeeds when customer redis offline");
});
