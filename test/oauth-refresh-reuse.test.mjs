// PR #6 re-verification issue 5 (LOW): inside the 60s grace window a reused
// old refresh token revoked the legitimate client's new tokens but handed the
// replayer a fresh live set. Now (RFC 9700 4.14) a reuse revokes BOTH token
// sets and returns invalid_grant.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __setRedisForTests,
  registerClient,
  mintTokens,
  lookupAccessToken,
  consumeRefresh,
  linkRefreshChildren,
  sha256hex,
  KEY,
} from "../api/oauth/_lib/storage.mjs";
import tokenHandler from "../api/oauth/token.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => __setRedisForTests(null));

const KEK = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };
const quiet = async (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = w;
  }
};

async function refresh(client_id, refresh_token) {
  const res = mockRes();
  await tokenHandler(mockReq({ method: "POST", body: { grant_type: "refresh_token", refresh_token, client_id } }), res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

async function setup(r) {
  __setRedisForTests(r);
  const c = await registerClient({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
  const t0 = await mintTokens({ client_id: c.client_id, scope: "mcp", sub: "rest:e.example", space: "acme", backend: { kind: "upstash", url: "https://e.example/exec", token: "SECRET" } });
  return { c, t0 };
}

for (const getdel of [true, false]) {
  const label = getdel ? "GETDEL" : "SET NX lock fallback";

  test(`refresh reuse: a replay inside the window revokes both token sets and gets invalid_grant (${label})`, async () => {
    await withEnv(KEK, async () => {
      const r = oauthRedis({ getdel });
      const { c, t0 } = await setup(r);

      const legit = await refresh(c.client_id, t0.refresh_token);
      assert.equal(legit.status, 200);
      assert.ok(await lookupAccessToken(legit.body.access_token));

      const replay = await quiet(() => refresh(c.client_id, t0.refresh_token));
      assert.equal(replay.status, 400);
      assert.equal(replay.body.error, "invalid_grant");
      assert.match(replay.body.error_description, /reuse detected/);
      assert.equal(replay.body.access_token, undefined, "the replayer gets no tokens");

      // Both families are dead: the original set and the rotated set.
      assert.equal(await lookupAccessToken(t0.access_token), null, "original access token revoked");
      assert.equal(await lookupAccessToken(legit.body.access_token), null, "rotated access token revoked");
      assert.equal(r.data.has(KEY.refresh(sha256hex(legit.body.refresh_token))), false, "rotated refresh token revoked");
      assert.equal((await quiet(() => refresh(c.client_id, legit.body.refresh_token))).status, 400);
      assert.equal((await refresh(c.client_id, t0.refresh_token)).status, 400, "further replays still fail");
    });
  });
}

test("refresh reuse: revocation follows further rotations inside the window", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const { c, t0 } = await setup(r);
    const t1 = (await refresh(c.client_id, t0.refresh_token)).body;
    const t2 = (await refresh(c.client_id, t1.refresh_token)).body;
    assert.ok(await lookupAccessToken(t2.access_token));

    const replay = await quiet(() => refresh(c.client_id, t0.refresh_token));
    assert.equal(replay.status, 400);
    for (const t of [t0, t1, t2]) assert.equal(await lookupAccessToken(t.access_token), null);
    assert.equal(r.data.has(KEY.refresh(sha256hex(t2.refresh_token))), false, "grandchild refresh token revoked");
  });
});

test("refresh reuse: a first use still in flight when reuse is detected discards what it minted", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const { c, t0 } = await setup(r);
    // First use consumed, but has not linked its children yet...
    const first = await consumeRefresh(t0.refresh_token, c.client_id);
    assert.ok(first.rec);
    // ...when a replay arrives.
    assert.deepEqual(await quiet(() => consumeRefresh(t0.refresh_token, c.client_id)), { reuse: true });
    const minted = await mintTokens({ ...first.rec, client_id: c.client_id });
    assert.deepEqual(await linkRefreshChildren(t0.refresh_token, minted), { revoked: true });
    assert.equal(await lookupAccessToken(minted.access_token), null);
    assert.equal(r.data.has(KEY.refresh(sha256hex(minted.refresh_token))), false);
  });
});

test("refresh reuse: a normal rotation outside any replay still works and links children", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const { c, t0 } = await setup(r);
    const t1 = await refresh(c.client_id, t0.refresh_token);
    assert.equal(t1.status, 200);
    const g = JSON.parse(r.data.get(KEY.refreshGrace(sha256hex(t0.refresh_token))).value);
    assert.deepEqual(g.children, { at: sha256hex(t1.body.access_token), rt: sha256hex(t1.body.refresh_token) });
    // A different client presenting the old token is a mismatch, not a reuse: nothing is revoked.
    const evil = await registerClient({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" });
    assert.equal((await refresh(evil.client_id, t0.refresh_token)).body.error_description, "refresh/client mismatch");
    assert.ok(await lookupAccessToken(t1.body.access_token));
  });
});
