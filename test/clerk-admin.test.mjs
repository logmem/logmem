import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { withEnv, mockReq, mockRes } from "./oauth-helpers.mjs";
import viewHandler from "../api/view.mjs";
import { __setAdminDepsForTests } from "../src/http/admin-auth.mjs";
import { inviteMany } from "../src/http/invites.mjs";

const ENV = {
  CLERK_SECRET_KEY: "sk_test_x",
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  VERCEL_ENV: "production",
  LOGMEM_VIEW_SPACES: "fieldnotes,madez",
};

const USER = "user_2abcDEF123ghiJKL";
const EMAIL = "ada+clerk_test@example.com";

function done() { __setAdminDepsForTests(null); }

test("clerk admin: allowlisted user can view /api/view", async () => {
  const redis = createMemoryRedis();
  await withEnv({ ...ENV, LOGMEM_ADMIN_EMAILS: EMAIL }, async () => {
    try {
      __setAdminDepsForTests({
        ready: () => true,
        session: async () => ({ status: "signed-in", userId: USER, email: EMAIL }),
        redis: () => redis,
      });
      const res = mockRes();
      await viewHandler({ method: "GET", url: "/api/view?space=fieldnotes&what=overview", query: { space: "fieldnotes", what: "overview" }, headers: { host: "logmem.test" } }, res);
      assert.equal(res.statusCode, 200, String(res.body));
    } finally { done(); }
  });
});

test("clerk admin: non-allowlisted provisioned user can view own tenant space", async () => {
  const redis = createMemoryRedis();
  await inviteMany([EMAIL], { redis });
  await withEnv(ENV, async () => {
    try {
      __setAdminDepsForTests({
        ready: () => true,
        session: async () => ({ status: "signed-in", userId: USER, email: EMAIL }),
        redis: () => redis,
      });
      const res = mockRes();
      await viewHandler({ method: "GET", url: "/api/view?space=t-placeholder&what=overview", query: { space: "t-placeholder", what: "overview" }, headers: { host: "logmem.test" } }, res);
      // space param will be replaced by first allowed; just ensure not 401
      // Fetch allowed space first by calling handler with no space
      const res2 = mockRes();
      await viewHandler({ method: "GET", url: "/api/view?what=overview", query: { what: "overview" }, headers: { host: "logmem.test" } }, res2);
      assert.equal(res2.statusCode, 200, String(res2.body));
      const body = JSON.parse(res2.body);
      assert.match(body.space, /^t-/);
    } finally { done(); }
  });
});

test("clerk admin: non-allowlisted cannot view other spaces", async () => {
  const redis = createMemoryRedis();
  await inviteMany([EMAIL], { redis });
  await withEnv(ENV, async () => {
    try {
      __setAdminDepsForTests({
        ready: () => true,
        session: async () => ({ status: "signed-in", userId: USER, email: EMAIL }),
        redis: () => redis,
      });
      const res = mockRes();
      await viewHandler({ method: "GET", url: "/api/view?space=fieldnotes&what=overview", query: { space: "fieldnotes", what: "overview" }, headers: { host: "logmem.test" } }, res);
      assert.equal(res.statusCode, 403);
    } finally { done(); }
  });
});

test("clerk admin: signed-out returns 401", async () => {
  const redis = createMemoryRedis();
  await withEnv(ENV, async () => {
    try {
      __setAdminDepsForTests({
        ready: () => true,
        session: async () => ({ status: "signed-out", signInUrl: "https://x" }),
        redis: () => redis,
      });
      const res = mockRes();
      await viewHandler({ method: "GET", url: "/api/view?space=fieldnotes&what=overview", query: { space: "fieldnotes", what: "overview" }, headers: { host: "logmem.test" } }, res);
      assert.equal(res.statusCode, 401);
    } finally { done(); }
  });
});
