import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { issueCookie, issueIdentityCookie, adminIdentity, isAdmin } from "../src/http/admin-auth.mjs";
import { createLoginHandler } from "../api/login.mjs";
import { createHandler as adminUsersHandler } from "../api/admin-users.mjs";
import { setRole, getRole } from "../src/http/admin-roles.mjs";
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
