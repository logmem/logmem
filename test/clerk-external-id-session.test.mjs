// Migration identity (P3): the session claim carries external_id, the old
// dev-instance id, while Clerk's session API reports the native id. Both
// sides must agree through the user record, and a filter row that does not
// really match must never be trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clerkSession, customerSession, userById } from '../src/http/clerk.mjs';
import { mockReq } from './oauth-helpers.mjs';

const env = {
  LOGMEM_CUSTOMER_DASHBOARD: '1',
  CLERK_SECRET_KEY: 'test-only-secret',
  CLERK_PUBLISHABLE_KEY: 'pk_test_' + Buffer.from('example.clerk.accounts.dev$').toString('base64'),
};
const OLD = 'user_oldmigrated1';
const NATIVE = 'user_newnative01';
const URL_ = 'https://logmem.test/api/session';

const user = (external) => ({
  id: NATIVE,
  external_id: external,
  primaryEmailAddressId: 'email1',
  emailAddresses: [{ id: 'email1', emailAddress: 'person@example.com', verification: { status: 'verified' } }],
});

function clientFor({ claimId = OLD, sessionUserId = NATIVE, extOfNative = OLD, listRows } = {}) {
  const calls = { getUser: 0, getUserList: 0 };
  return {
    calls,
    authenticateRequest: async () => ({
      status: 'signed-in',
      headers: new Headers(),
      toAuth: () => ({ userId: claimId, sessionId: 'sess_mig' }),
    }),
    users: {
      getUser: async (id) => {
        calls.getUser += 1;
        if (id === NATIVE) return user(extOfNative);
        const err = new Error('not found');
        err.status = 404;
        throw err; // native API refuses an external_id, like production
      },
      getUserList: async (filter) => {
        calls.getUserList += 1;
        return { data: listRows !== undefined ? listRows : [{ ...user(filter.externalId?.[0]), external_id: filter.externalId?.[0] }] };
      },
    },
    sessions: {
      getSession: async () => ({ status: 'active', userId: sessionUserId }),
    },
  };
}

test('signed-in claim that is an external_id still resolves the email and keeps the old id', async () => {
  const client = clientFor({ claimId: OLD });
  const s = await clerkSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-in');
  assert.equal(s.userId, OLD, 'identity stays the old id the workspace members use');
  assert.equal(s.email, 'person@example.com');
  assert.ok(client.calls.getUserList >= 1, 'fell back to the external_id filter');
});

test('a filter row whose external_id does not match is never trusted', async () => {
  const client = clientFor({ claimId: OLD, listRows: [{ ...user(OLD), external_id: 'user_someoneelse1' }] });
  const s = await clerkSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-out');
});

test('native ids take the fast path without a filter lookup', async () => {
  const client = clientFor({ claimId: NATIVE, sessionUserId: NATIVE, extOfNative: null });
  const s = await clerkSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-in');
  assert.equal(s.userId, NATIVE);
  assert.equal(client.calls.getUserList, 0, 'no filter call for a native id');
});

test('customerSession accepts a migrated user when the record maps native to old', async () => {
  const client = clientFor({ claimId: OLD, sessionUserId: NATIVE, extOfNative: OLD });
  const s = await customerSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-in');
  assert.equal(s.userId, OLD);
});

test('customerSession signs out when the record maps to a different external_id', async () => {
  const client = clientFor({ claimId: OLD, sessionUserId: NATIVE, extOfNative: 'user_otherperson1' });
  const s = await customerSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-out');
});

test('customerSession keeps the native fast path (single getUser, no mapping call)', async () => {
  const client = clientFor({ claimId: NATIVE, sessionUserId: NATIVE, extOfNative: null });
  const s = await customerSession(mockReq({ headers: {} }), { env, url: URL_, client });
  assert.equal(s.status, 'signed-in');
  assert.equal(client.calls.getUser, 1, 'one call for the email, none for mapping');
});

test('userById returns null for a missing id instead of throwing', async () => {
  const client = clientFor({ claimId: OLD, listRows: [] });
  const u = await userById(client, 'user_ghost0000001');
  assert.equal(u, null);
});
