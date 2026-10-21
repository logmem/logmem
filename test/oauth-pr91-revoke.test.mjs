// codex review of PR 91 at b4ae0c8: revocation must win against an in-flight
// refresh (P1), and must also revoke legacy raw-keyed tokens in-window (P2).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setRedisForTests, __setClockForTests, registerClient, mintTokens, consumeRefresh, linkRefreshChildren, lookupAccessToken, KEY, sha256hex, LEGACY_CUTOFF_MS } from "../api/oauth/_lib/storage.mjs";
import revokeHandler from "../api/oauth/revoke.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => { __setRedisForTests(null); __setClockForTests(null); });
const ENV = { LOGMEM_ISSUER: "https://logmem.si", LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined, LOGMEM_MANAGED: undefined };
const revoke = async (body) => { const res = mockRes(); await revokeHandler(mockReq({ method: "POST", url: "/api/oauth/revoke", body }), res); return res; };

async function setup(backend = { kind: "redis", uri: "rediss://default:pw@redis.example:6380/0" }) {
  const r = oauthRedis();
  __setRedisForTests(r);
  const client = await registerClient({ redirect_uris: ["https://app.example/cb"], client_name: "App" });
  const t = await mintTokens({ client_id: client.client_id, scope: "mcp", backend, sub: "x", space: "acme", resource: "https://logmem.si/mcp" });
  return { r, client, t };
}

test("P1: a revoke that lands while a refresh is in flight revokes the grant and what the refresh mints", async () => {
  await withEnv(ENV, async () => {
    const { client, t } = await setup();
    // The refresh starts: it consumes the live record and leaves a grace record.
    const got = await consumeRefresh(t.refresh_token, client.client_id);
    assert.ok(got?.rec, "the refresh consumed the token");
    // The revoke lands now, before the refresh mints.
    assert.equal((await revoke({ token: t.refresh_token, client_id: client.client_id })).statusCode, 200);
    // The refresh finishes: it mints and links. The minted pair must not survive.
    const minted = await mintTokens({ ...got.rec, fid: got.rec.fid });
    const linked = await linkRefreshChildren(t.refresh_token, minted, got.rec.fid);
    assert.equal(linked.revoked, true, "the in-flight refresh sees the revocation");
    assert.equal(await lookupAccessToken(minted.access_token), null, "the newly minted access token is unusable");
    assert.equal(await lookupAccessToken(t.access_token), null, "the original access token is gone");
    assert.equal(await consumeRefresh(minted.refresh_token, client.client_id), null, "the new refresh token is gone");
  });
});

test("P1: the in-flight case disconnects a managed app too", async () => {
  await withEnv(ENV, async () => {
    const { r, client, t } = await setup({ kind: "managed", tenant: "uabcdefghij", agent: "muse" });
    const fid = (await lookupAccessToken(t.access_token)).fid;
    assert.ok(r.data.has(`lm:account:app:${fid}`), "connected-app record exists");
    const got = await consumeRefresh(t.refresh_token, client.client_id);
    await revoke({ token: t.refresh_token, client_id: client.client_id });
    assert.equal(r.data.has(`lm:account:app:${fid}`), false, "the managed app is disconnected");
    const minted = await mintTokens({ ...got.rec, fid: got.rec.fid });
    assert.equal((await linkRefreshChildren(t.refresh_token, minted, fid)).revoked, true);
  });
});

test("P1: another client's in-flight token is untouched", async () => {
  await withEnv(ENV, async () => {
    const { client, t } = await setup();
    const other = await registerClient({ redirect_uris: ["https://evil.example/cb"], client_name: "Other" });
    const got = await consumeRefresh(t.refresh_token, client.client_id);
    assert.equal((await revoke({ token: t.refresh_token, client_id: other.client_id })).statusCode, 200);
    const minted = await mintTokens({ ...got.rec, fid: got.rec.fid });
    assert.equal((await linkRefreshChildren(t.refresh_token, minted, got.rec.fid)).revoked, false);
    assert.ok(await lookupAccessToken(minted.access_token));
  });
});

test("P2: legacy raw-keyed access and refresh tokens are revoked in-window, own client only", async () => {
  await withEnv(ENV, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const client = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    __setClockForTests(() => LEGACY_CUTOFF_MS - 86400000);
    const at = "a".repeat(64), rt = "b".repeat(64), sib = "c".repeat(64);
    const put = (k, v) => r.data.set(k, { type: "string", value: JSON.stringify(v) });
    put(KEY.legacyAccess(at), { client_id: client.client_id, space: "old", upstash_url: "https://x", upstash_token: "t", expires_at: 9e9 });
    put(KEY.legacyRefresh(rt), { client_id: client.client_id, space: "old", upstash_url: "https://x", upstash_token: "t", sibling_at: sib });
    put(KEY.legacyAccess(sib), { client_id: client.client_id, space: "old", upstash_url: "https://x", upstash_token: "t", expires_at: 9e9 });

    // Another client cannot revoke them.
    const other = await registerClient({ redirect_uris: ["https://evil.example/cb"] });
    await revoke({ token: at, client_id: other.client_id });
    assert.ok(await lookupAccessToken(at));

    await revoke({ token: at, client_id: client.client_id });
    assert.equal(await lookupAccessToken(at), null, "legacy access token revoked");
    await revoke({ token: rt, client_id: client.client_id });
    assert.equal(r.data.has(KEY.legacyRefresh(rt)), false, "legacy refresh token revoked");
    assert.equal(await lookupAccessToken(sib), null, "its sibling access token too");
    assert.equal(await consumeRefresh(rt, client.client_id), null);
  });
});

test("P2: a sealed record planted under a legacy key is not touched by legacy revoke", async () => {
  await withEnv(ENV, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const client = await registerClient({ redirect_uris: ["https://app.example/cb"] });
    __setClockForTests(() => LEGACY_CUTOFF_MS - 86400000);
    const raw = "d".repeat(64);
    r.data.set(KEY.legacyAccess(raw), { type: "string", value: JSON.stringify({ client_id: client.client_id, creds: "sealed" }) });
    await revoke({ token: raw, client_id: client.client_id });
    assert.ok(r.data.has(KEY.legacyAccess(raw)));
  });
});
