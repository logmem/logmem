// PR #6 re-verification issue 3 (MEDIUM): the sealed creds' AAD was a
// constant, so someone with write access to the deploy Redis (but no KEK)
// could copy a victim's sealed blob under their own token/space/client and
// have LogMem open it. The v2 AAD binds kind, key hash and every plaintext
// field; v1 envelopes still open until LEGACY_CUTOFF_MS so prod can migrate.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  __setRedisForTests,
  __setClockForTests,
  LEGACY_CUTOFF_MS,
  mintTokens,
  lookupAccessToken,
  saveAuthCode,
  consumeAuthCode,
  consumeRefresh,
  sha256hex,
  KEY,
} from "../api/oauth/_lib/storage.mjs";
import { migrateLegacy } from "../scripts/oauth-legacy-seal.mjs";
import { oauthRedis, withEnv, TEST_KEK_HEX } from "./oauth-helpers.mjs";

afterEach(() => {
  __setRedisForTests(null);
  __setClockForTests(null);
});

const KEK = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined };
const VICTIM_SECRET = "victim-upstash-token";
const victim = () => ({ client_id: "cli_victim", scope: "mcp", sub: "rest:victim.example", space: "victim", upstash_url: "https://victim.example/exec", upstash_token: VICTIM_SECRET, backend: { kind: "upstash", url: "https://victim.example/exec", token: VICTIM_SECRET } });
const attacker = () => ({ client_id: "cli_attacker", scope: "mcp", sub: "rest:attacker.example", space: "attacker", upstash_url: "https://attacker.example/exec", upstash_token: "attacker-token", backend: { kind: "upstash", url: "https://attacker.example/exec", token: "attacker-token" } });

const get = (r, k) => JSON.parse(r.data.get(k).value);
const put = (r, k, v) => r.data.set(k, { type: "string", value: JSON.stringify(v) });
const quiet = async (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = w;
  }
};

test("aad: a victim's sealed access-token creds copied under the attacker's token do not open", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const v = await mintTokens(victim());
    const a = await mintTokens(attacker());
    const vKey = KEY.access(sha256hex(v.access_token));
    const aKey = KEY.access(sha256hex(a.access_token));
    const vRec = get(r, vKey);
    const aRec = get(r, aKey);

    await quiet(async () => {
      // 1. The attacker's own plaintext fields + the victim's envelope.
      put(r, aKey, { ...aRec, creds: vRec.creds });
      assert.equal(await lookupAccessToken(a.access_token), null, "victim blob under attacker's key/fields");
      // 2. The victim's whole record under the attacker's key (key-hash binding).
      put(r, aKey, vRec);
      assert.equal(await lookupAccessToken(a.access_token), null, "whole victim record under attacker key");
      // 3. Victim's own key, but the plaintext space / expiry / client edited.
      for (const edit of [{ space: "attacker" }, { expires_at: vRec.expires_at + 86400 * 365 }, { client_id: "cli_attacker" }, { sub: "rest:x" }, { scope: "admin" }]) {
        put(r, vKey, { ...vRec, ...edit });
        assert.equal(await lookupAccessToken(v.access_token), null, `edited ${Object.keys(edit)[0]}`);
      }
      // 4. Same hash, other kind: the access record planted as a refresh record.
      put(r, KEY.refresh(sha256hex(v.access_token)), vRec);
      assert.equal(await consumeRefresh(v.access_token, "cli_victim"), null, "kind binding");
    });

    // The untouched record still opens.
    put(r, vKey, vRec);
    assert.equal((await lookupAccessToken(v.access_token)).upstash_token, VICTIM_SECRET);
  });
});

test("aad: copied refresh-token and auth-code envelopes do not open either", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const v = await mintTokens(victim());
    const a = await mintTokens(attacker());
    const aRtKey = KEY.refresh(sha256hex(a.refresh_token));
    put(r, aRtKey, { ...get(r, aRtKey), creds: get(r, KEY.refresh(sha256hex(v.refresh_token))).creds });
    assert.equal(await quiet(() => consumeRefresh(a.refresh_token, "cli_attacker")), null);

    const vCode = await saveAuthCode({ ...victim(), redirect_uri: "https://victim.example/cb", code_challenge: "c".repeat(43) });
    const aCode = await saveAuthCode({ ...attacker(), redirect_uri: "https://attacker.example/cb", code_challenge: "d".repeat(43) });
    const aCodeKey = KEY.code(sha256hex(aCode));
    put(r, aCodeKey, { ...get(r, aCodeKey), creds: get(r, KEY.code(sha256hex(vCode))).creds });
    assert.equal(await quiet(() => consumeAuthCode(aCode)), null);
    // Editing redirect_uri / code_challenge on the victim's own code also breaks it.
    const vCodeKey = KEY.code(sha256hex(vCode));
    const vRec = get(r, vCodeKey);
    put(r, vCodeKey, { ...vRec, redirect_uri: "https://attacker.example/cb" });
    assert.equal(await quiet(() => consumeAuthCode(vCode)), null);
  });
});

/** Seal exactly like the pre-v2 code did: constant AAD, no `v` field. */
function sealV1(creds) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(TEST_KEK_HEX, "hex"), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from("logmem-oauth-creds-v1"));
  const ct = Buffer.concat([c.update(JSON.stringify(creds), "utf8"), c.final()]);
  return { enc: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

const v1Record = () => ({ client_id: "cli_old", scope: "mcp", sub: "rest:old.example", space: "old", issued_at: 1, expires_at: 9e9, creds: sealV1({ backend: { kind: "upstash", url: "https://old.example/exec", token: "OLD-SECRET" }, upstash_url: "https://old.example/exec", upstash_token: "OLD-SECRET" }) });

test("aad: a legacy v1 (constant-AAD) record opens before the cutoff and not after", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    __setRedisForTests(r);
    const token = "e".repeat(64);
    put(r, KEY.access(sha256hex(token)), v1Record());
    __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);
    assert.equal((await lookupAccessToken(token)).upstash_token, "OLD-SECRET");
    __setClockForTests(() => LEGACY_CUTOFF_MS + 1);
    assert.equal(await quiet(() => lookupAccessToken(token)), null);
  });
});

test("aad: oauth-legacy-seal re-seals v1 records as v2 so they survive the cutoff", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const at = "f".repeat(64);
    const rt = "9".repeat(64);
    const atKey = KEY.access(sha256hex(at));
    const rtKey = KEY.refresh(sha256hex(rt));
    put(r, atKey, v1Record());
    r.ttls.set(atKey, 4321);
    put(r, rtKey, v1Record());
    r.ttls.set(rtKey, 8765);
    __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);

    const before = JSON.stringify([...r.data.entries()]);
    const logs = [];
    const dry = await migrateLegacy(r, { log: (m) => logs.push(m) });
    assert.equal(dry.actions.filter((x) => x.action === "reseal").length, 2);
    assert.equal(JSON.stringify([...r.data.entries()]), before, "dry run writes nothing");
    assert.ok(!logs.join("\n").includes("OLD-SECRET"));

    const done = await migrateLegacy(r, { apply: true });
    assert.equal(done.resealed, 2);
    assert.equal(get(r, atKey).creds.v, 2);
    assert.equal(r.ttls.get(atKey), 4321, "remaining TTL kept");
    assert.equal(r.ttls.get(rtKey), 8765);

    __setRedisForTests(r);
    __setClockForTests(() => LEGACY_CUTOFF_MS + 1);
    assert.equal((await lookupAccessToken(at)).upstash_token, "OLD-SECRET", "v2 record opens after the cutoff");
    assert.equal((await consumeRefresh(rt, "cli_old")).rec.space, "old");
  });
});
