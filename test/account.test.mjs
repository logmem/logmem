// Phase 6.2 slice 2: profile and security rows, self-only, real Clerk data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { profileRows, securityRows, accountRows, AccountError } from "../src/http/account.mjs";

const baseUser = {
  id: "user_2n8kQ0test",
  firstName: "Mikey",
  lastName: "Shaw",
  passwordEnabled: true,
  primaryEmailAddressId: "emn_primary",
  emailAddresses: [
    { id: "emn_primary", emailAddress: "mikey@example.com", verification: { status: "verified" } },
    { id: "emn_other", emailAddress: "old@example.com", verification: { status: "unverified" } },
  ],
  externalAccounts: [{ provider: "google", verification: { status: "verified" } }],
  createdAt: 1762000000000,
  mfaEnabled: true,
  lastSignInAt: 1794900000000,
};

const rowsOf = (rows, key) => rows.find((r) => r.key === key);

test("profile rows carry only real Clerk values", () => {
  const rows = profileRows(baseUser);
  assert.equal(rowsOf(rows, "account_id").value, "user_2n8kQ0test");
  assert.equal(rowsOf(rows, "display_name").value, "Mikey Shaw");
  assert.equal(rowsOf(rows, "primary_email").value, "mikey@example.com");
  assert.equal(rowsOf(rows, "primary_email").state, "verified");
  assert.equal(rowsOf(rows, "sign_in_methods").value, "google, password");
  assert.equal(rowsOf(rows, "created").value, "2025-11-01");
});

test("an unverified email is never presented as the address", () => {
  const user = { ...baseUser, emailAddresses: [{ id: "emn_primary", emailAddress: "new@example.com", verification: { status: "unverified" } }] };
  const row = rowsOf(profileRows(user), "primary_email");
  assert.equal(row.value, null);
  assert.equal(row.state, "unverified");
});

test("a missing display name shows not_set, never a blank guess", () => {
  const row = rowsOf(profileRows({ ...baseUser, firstName: null, lastName: null }), "display_name");
  assert.equal(row.value, null);
  assert.equal(row.state, "not_set");
});

test("security rows appear only when the source field exists", () => {
  const full = securityRows(baseUser);
  assert.equal(rowsOf(full, "password").value, "set");
  assert.equal(rowsOf(full, "mfa").value, "on");
  assert.equal(rowsOf(full, "last_sign_in").value, new Date(1794900000000).toISOString().slice(0, 10));
  assert.equal(rowsOf(full, "connected_google").value, "connected");

  const sparse = securityRows({ id: "user_x", passwordEnabled: false });
  assert.equal(rowsOf(sparse, "password").value, "not_set");
  assert.equal(rowsOf(sparse, "mfa"), undefined, "no mfa field, no mfa row");
  assert.equal(rowsOf(sparse, "last_sign_in"), undefined, "no last sign-in, no row");
  assert.equal(sparse.some((r) => r.key.startsWith("connected_")), false);
});

test("account rows read exactly one user: the given session id", async () => {
  const seen = [];
  const clerk = { users: { getUser: async (id) => { seen.push(id); return { data: { ...baseUser, id } }; } } };
  const out = await accountRows({ userId: "user_2n8kQ0test", clerk });
  assert.deepEqual(seen, ["user_2n8kQ0test"], "only the caller's id is ever requested");
  assert.equal(out.ok, true);
  assert.ok(out.data.profile.length >= 4);
  assert.ok(out.data.security.length >= 3);
});

test("no session id is a401, a missing user is a404, upstream failure is a502", async () => {
  await assert.rejects(accountRows({ clerk: {} }), (e) => e instanceof AccountError && e.code === "sign_in_required" && e.status === 401);
  const missing = { users: { getUser: async () => { const err = new Error("nf"); err.status = 404; throw err; } } };
  await assert.rejects(accountRows({ userId: "user_z", clerk: missing }), (e) => e.code === "account_not_found" && e.status === 404);
  const down = { users: { getUser: async () => { throw new Error("boom"); } } };
  await assert.rejects(accountRows({ userId: "user_z", clerk: down }), (e) => e.code === "clerk_unavailable" && e.status === 502);
});

test("an unconfigured Clerk is a503, not a crash", async () => {
  await assert.rejects(
    accountRows({ userId: "user_z", env: {} }),
    (e) => e instanceof AccountError && e.code === "clerk_unconfigured" && e.status === 503
  );
});
