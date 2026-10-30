import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import {
  ROLES, normUser, getRole, setRole, listRoles, isSuspended,
  suspendUser, unsuspendUser, suspendedList, audit,
} from "../src/http/admin-roles.mjs";
import { createAgentKey, lookupAgentKey, revokeAgentKey } from "../src/http/agent-keys.mjs";
import { customerIdentity } from "../src/http/customer-http.mjs";
import { createWorkspace, readWorkspace } from "../src/http/workspaces.mjs";
import { createWorkspaceAgentKey, lookupWorkspaceAgentKey } from "../src/http/workspace-agent-keys.mjs";
import { createHandler as adminUsersHandler } from "../api/admin-users.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";

const ADMIN = "user_madezadmin0001";
const VICTIM = "user_suzanne000001";
const ADMIN_ENV = { LOGMEM_ADMIN_PASSWORD: "pw" };
const ADMIN_COOKIE = issueCookie(ADMIN_ENV).split(";")[0]; // real HMAC cookie

test("roles: set, get, list, validate", async () => {
  const redis = createMemoryRedis();
  assert.equal(normUser(`human:${ADMIN}`), ADMIN, "human: prefix strips");
  for (const bad of ["", "x y", "role with space"]) assert.throws(() => normUser(bad));
  await assert.rejects(setRole({ actorId: "a", userId: ADMIN, role: "superuser", redis }), /invalid role/);
  await setRole({ actorId: "break-glass", userId: ADMIN, role: "admin", redis });
  await setRole({ actorId: "break-glass", userId: VICTIM, role: "viewer", redis });
  assert.equal((await getRole(ADMIN, redis)).role, "admin");
  assert.equal(await getRole("user_nobody00000000", redis), null);
  const all = await listRoles(redis);
  assert.equal(all.length, 2);
  assert.deepEqual([...ROLES].sort(), ["admin", "billing", "support", "viewer"]);
});

test("suspend: record, audit trail, unsuspend restores", async () => {
  const redis = createMemoryRedis();
  assert.equal(await isSuspended(VICTIM, redis), false);
  const r = await suspendUser({ actorId: "break-glass", userId: VICTIM, reason: "test stop", redis });
  assert.deepEqual(r, { userId: VICTIM, revoked_keys: [] });
  assert.equal(await isSuspended(VICTIM, redis), true);
  assert.deepEqual(await suspendedList(redis), [VICTIM]);
  const trail = (await redis("ZRANGE", "lm:admin:audit", 0, -1)).map((x) => JSON.parse(x));
  assert.ok(trail.some((e) => e.action === "suspend" && e.target === VICTIM && e.by === "break-glass"), "suspend audited");
  await unsuspendUser({ actorId: "break-glass", userId: VICTIM, redis });
  assert.equal(await isSuspended(VICTIM, redis), false);
  const after = (await redis("ZRANGE", "lm:admin:audit", 0, -1)).map((x) => JSON.parse(x));
  assert.ok(after.some((e) => e.action === "unsuspend"), "unsuspend audited");
});

test("cascade: suspending an owner revokes their fleet keys", async () => {
  const store = createMemoryRedis();
  const mint = await createAgentKey({ space: "beta1", agent: "beta1-agent1", label: "victim agent", by: "human:admin", owner: VICTIM }, { redis: store, env: { LOGMEM_SPACES: "madez,beta1" } });
  assert.equal(mint.owner, VICTIM, "owner lands on the record");
  assert.ok(await lookupAgentKey(mint.key, { redis: store }), "key resolves before suspend");
  await suspendUser({ actorId: "break-glass", userId: VICTIM, redis: createMemoryRedis(), deployRedis: store });
  assert.equal(await lookupAgentKey(mint.key, { redis: store }), null, "key dead after suspend");
  // unsuspend does NOT resurrect a revoked key (revoke is permanent)
  await unsuspendUser({ actorId: "break-glass", userId: VICTIM, redis: createMemoryRedis() });
  assert.equal(await lookupAgentKey(mint.key, { redis: store }), null, "revocation stays revoked");
});

test("unchanged: keys without an owner are unaffected by suspension machinery", async () => {
  const store = createMemoryRedis();
  const mint = await createAgentKey({ space: "madez", agent: "legacy-agent", label: "legacy", by: "human:admin" }, { redis: store });
  assert.equal(mint.owner, undefined, "no owner field when not provided");
  assert.ok(await lookupAgentKey(mint.key, { redis: store }), "legacy key resolves");
});

test("customerIdentity: suspended account is stopped with account_suspended", async () => {
  const redis = createMemoryRedis();
  const env = { LOGMEM_CUSTOMER_DASHBOARD: "1" };
  const session = async () => ({ status: "signed-in", userId: VICTIM, email: "s@e.com", sessionId: "sess_1" });
  const deps = { session, redis, env };
  const req = mockReq({ url: "/api/session" });
  const ok = await customerIdentity(req, deps);
  assert.equal(ok.session.userId, VICTIM, "healthy session passes");
  await suspendUser({ actorId: "break-glass", userId: VICTIM, redis, deployRedis: createMemoryRedis() });
  await assert.rejects(customerIdentity(req, deps), (e) => e.code === "account_suspended" && e.status === 403);
});

test("workspace keys: a suspended issuer dies at lookup", async () => {
  const redis = createMemoryRedis();
  const deps = { redis, now: () => 1000000 };
  const { workspace: w, space: s } = await createWorkspace({ userId: VICTIM, name: "Shaw", firstSpaceName: "main", requestId: "create-0001" }, deps);
  const key = await createWorkspaceAgentKey({ userId: VICTIM, workspaceId: w.id, spaceId: s.id, agent: "shaw-agent", requestId: "key-0001" }, deps);
  assert.ok(await lookupWorkspaceAgentKey(key.key, { redis }), "workspace key resolves before suspend");
  await suspendUser({ actorId: "break-glass", userId: VICTIM, redis, deployRedis: createMemoryRedis() });
  assert.equal(await lookupWorkspaceAgentKey(key.key, { redis }), null, "workspace key dead after suspend");
});

test("admin route gates: cookie, intent, happy path", async () => {
  const redis = createMemoryRedis();
  const handler = adminUsersHandler({ env: ADMIN_ENV, redis: () => redis, deploy: () => createMemoryRedis() });
  // no cookie -> 401
  let res = mockRes();
  await handler(mockReq({ url: "/api/admin-users" }), res);
  assert.equal(res.statusCode, 401);
  // cookie, GET -> roles payload
  res = mockRes();
  await handler(mockReq({ url: "/api/admin-users", headers: { cookie: ADMIN_COOKIE } }), res);
  assert.equal(res.statusCode, 200);
  const got = JSON.parse(res.body);
  assert.equal(got.ok, true);
  assert.deepEqual(got.allowed_roles, ROLES);
  // cookie but wrong intent -> 403
  res = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: { cookie: ADMIN_COOKIE, "x-logmem-intent": "wrong" }, body: { action: "set-role" } }), res);
  assert.equal(res.statusCode, 403);
  // cookie + intent -> set-role lands
  res = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/admin-users", headers: { cookie: ADMIN_COOKIE, "x-logmem-intent": "admin-users", origin: "https://logmem.si", host: "logmem.si" }, body: { action: "set-role", userId: VICTIM, role: "billing" } }), res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await getRole(VICTIM, redis)).role, "billing");
});
