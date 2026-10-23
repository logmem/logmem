// Managed accounts and beta invites (one-click connect plan, task 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, mockRes, mockReq } from "./oauth-helpers.mjs";
import { accountFor, newTenantId, ownerOf, AccountError } from "../src/http/accounts.mjs";
import { inviteMany, isInvited, listInvites, inviteHash, InviteError } from "../src/http/invites.mjs";
import { createTenant, getTenant, listTenants, validTenantId } from "../cloud/tenants/index.mjs";
import { listSignups } from "../src/http/waitlist-store.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/invites.mjs";

const USER = "user_2abcDEF123ghiJKL";
const EMAIL = "ada+clerk_test@example.com";

test("invites: keyed by the hash of the normalized email, never the email", async () => {
  const redis = oauthRedis();
  assert.equal(await isInvited(EMAIL, { redis, env: {} }), false);
  const r = await inviteMany(["  ADA+clerk_test@Example.com ", "not an email", EMAIL], { redis, by: "human:mikey" });
  assert.deepEqual(r, { invited: 1, already: 1, invalid: 1 });
  assert.equal(await isInvited(EMAIL, { redis, env: {} }), true);
  const stored = JSON.stringify([...redis.data.entries()]);
  assert.ok(!stored.includes("example.com"), "no email is stored");
  const list = await listInvites({ redis });
  assert.equal(list.length, 1);
  assert.equal(list[0].hash, inviteHash(EMAIL));
  assert.equal(await isInvited("someone@example.com", { redis, env: { LOGMEM_SIGNUP_OPEN: "1" } }), true, "the open switch");
  await assert.rejects(() => inviteMany([], { redis }), InviteError);
  await assert.rejects(() => inviteMany(Array(201).fill(EMAIL), { redis }), InviteError);
});

test("accounts: not invited means no tenant and a waitlist row", async () => {
  const redis = oauthRedis();
  const waitlistRedis = createMemoryRedis();
  const r = await accountFor({ clerkUserId: USER, email: EMAIL }, { redis, waitlistRedis, env: {} });
  assert.deepEqual(r, { waitlist: true });
  assert.equal(await redis("GET", `lm:account:clerk:${USER}`), null);
  const rows = await listSignups(waitlistRedis);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].utm_source, "connect");
});

test("accounts: an invited first sign-in makes one free tenant; later sign-ins reuse it", async () => {
  const redis = oauthRedis();
  await inviteMany([EMAIL], { redis });
  const a = await accountFor({ clerkUserId: USER, email: EMAIL }, { redis, env: {} });
  assert.equal(a.created, true);
  assert.ok(validTenantId(a.tenant) && /^u[a-z0-9]{10}$/.test(a.tenant));
  assert.equal(a.space, `t-${a.tenant}`);
  assert.equal(a.plan, "free");
  assert.ok(!a.tenant.includes("ada"), "the tenant id never comes from the email");
  assert.equal((await getTenant(redis, a.tenant)).plan, "free");
  assert.equal(await ownerOf(a.tenant, { redis }), USER);
  const b = await accountFor({ clerkUserId: USER, email: EMAIL }, { redis, env: {} });
  assert.equal(b.tenant, a.tenant);
  assert.equal(b.created, false);
});

test("accounts: two first sign-ins at once make exactly one tenant", async () => {
  const redis = oauthRedis();
  await inviteMany([EMAIL], { redis });
  const ids = ["uaaaaaaaaaa", "ubbbbbbbbbb"];
  const [x, y] = await Promise.all(ids.map((id) => accountFor({ clerkUserId: USER, email: EMAIL }, { redis, env: {}, newId: () => id })));
  assert.equal(x.tenant, y.tenant, "both see the same tenant");
  assert.equal([x.created, y.created].filter(Boolean).length, 1);
  assert.equal((await listTenants(redis)).length, 1, "exactly one tenant exists");
});

test("accounts: bad input is refused", async () => {
  const redis = oauthRedis();
  await assert.rejects(() => accountFor({ clerkUserId: "nope", email: EMAIL }, { redis, env: {} }), AccountError);
  await redis("SET", `lm:account:clerk:${USER}`, "../../x");
  await assert.rejects(() => accountFor({ clerkUserId: USER, email: EMAIL }, { redis, env: {} }), AccountError);
  assert.match(newTenantId(), /^u[a-z0-9]{10}$/);
});

const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production" };
const cookie = issueCookie(ENV).split(";")[0];
const call = async (h, { method = "GET", body, headers = {} } = {}) => {
  const req = mockReq({ method, url: "/api/invites", body, headers: { host: "logmem.si", ...headers } });
  const res = mockRes();
  await h(req, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
};

test("invites API: admin only, intent header and same origin on writes, hashes only on reads", async () => {
  const redis = oauthRedis();
  const h = createHandler({ env: ENV, redis: () => redis });
  assert.equal((await call(h)).status, 401);
  assert.equal((await call(h, { method: "POST", body: { emails: [EMAIL] }, headers: { cookie } })).status, 403);
  assert.equal((await call(h, { method: "POST", body: { emails: [EMAIL] }, headers: { cookie, "x-logmem-intent": "invites", origin: "https://evil.example" } })).status, 403);
  const w = { cookie, "x-logmem-intent": "invites", origin: "https://logmem.si" };
  assert.deepEqual((await call(h, { method: "POST", body: { emails: [EMAIL] }, headers: w })).body, { invited: 1, already: 0, invalid: 0 });
  const got = await call(h, { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.body.open, false);
  assert.ok(!JSON.stringify(got.body).includes("example.com"), "the list carries hashes, not emails");
  assert.equal((await call(h, { method: "POST", body: { emails: [] }, headers: w })).status, 400);
});

test("invites API: no customer Redis is a 503, not a crash", async () => {
  const h = createHandler({ env: ENV });
  assert.equal((await call(h, { headers: { cookie } })).status, 503);
});

test("accounts: an interrupted owner write is repaired on the next sign-in", async () => {
  const redis = oauthRedis();
  const tenant = "urepair00000";
  await redis("SET", `lm:account:clerk:${USER}`, tenant);
  let fail = true;
  const flaky = async (...args) => {
    if (fail && args[0] === "SET" && args[1] === `lm:account:tenant:${tenant}`) {
      fail = false;
      throw new Error("owner write unavailable");
    }
    return redis(...args);
  };
  await assert.rejects(accountFor({ clerkUserId: USER }, { redis: flaky }), /unavailable/);
  const account = await accountFor({ clerkUserId: USER }, { redis: flaky });
  assert.equal(account.tenant, tenant);
  assert.equal(await ownerOf(tenant, { redis }), USER);
});

test("accounts: a candidate collision never adopts or overwrites another account", async () => {
  const redis = oauthRedis();
  const other = "user_OTHER123456789";
  const first = await accountFor({ clerkUserId: USER, email: EMAIL }, { redis, env: { LOGMEM_SIGNUP_OPEN: "1" }, newId: () => "ucollision0" });
  const ids = [first.tenant, "ufresh00000"];
  const second = await accountFor({ clerkUserId: other, email: EMAIL }, { redis, env: { LOGMEM_SIGNUP_OPEN: "1" }, newId: () => ids.shift() });
  assert.notEqual(first.tenant, second.tenant);
  assert.equal(await ownerOf(first.tenant, { redis }), USER);
  assert.equal(await ownerOf(second.tenant, { redis }), other);
  await redis("SET", `lm:account:clerk:${other}`, first.tenant);
  await assert.rejects(accountFor({ clerkUserId: other }, { redis }), /owner does not match/);
  assert.equal(await ownerOf(first.tenant, { redis }), USER);
});

test("accounts: concurrent users cannot share a generated candidate", async () => {
  const redis = oauthRedis();
  const other = "user_OTHER123456789";
  const result = await Promise.allSettled([USER, other].map((clerkUserId, index) => {
    let attempt = 0;
    return accountFor({ clerkUserId, email: EMAIL }, {
      redis, env: { LOGMEM_SIGNUP_OPEN: "1" }, newId: () => attempt++ === 0 ? "usame000000" : `ufallback00${index}`,
    });
  }));
  assert.ok(result.every((r) => r.status === "fulfilled"));
  assert.notEqual(result[0].value.tenant, result[1].value.tenant);
  assert.equal(await ownerOf(result[0].value.tenant, { redis }), USER);
  assert.equal(await ownerOf(result[1].value.tenant, { redis }), other);
});

test("accounts: a generated id never adopts a tenant without an account owner", async () => {
  const redis = oauthRedis();
  await createTenant(redis, { id: "uexisting00", name: "Existing", plan: "free" });
  const ids = ["uexisting00", "uavailable0"];
  const account = await accountFor({ clerkUserId: USER, email: EMAIL }, {
    redis, env: { LOGMEM_SIGNUP_OPEN: "1" }, newId: () => ids.shift(),
  });
  assert.equal(account.tenant, "uavailable0");
  assert.equal(await ownerOf("uexisting00", { redis }), null);
});
