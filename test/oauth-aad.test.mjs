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

test("aad: oauth-legacy-seal never re-seals v1 records into v2 (no laundering of spliced blobs)", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const at = "f".repeat(64);
    const atKey = KEY.access(sha256hex(at));
    // An attacker with Redis write splices a v1 blob under their own key with a far-future expiry.
    put(r, atKey, { ...v1Record(), expires_at: 4102444800 });
    r.ttls.set(atKey, 4321);
    __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);
    const before = JSON.stringify([...r.data.entries()]);

    const done = await migrateLegacy(r, { apply: true });
    assert.equal(done.v1Kept, 1);
    assert.equal(done.resealed, undefined, "no re-seal path any more");
    assert.equal(JSON.stringify([...r.data.entries()]), before, "the v1 record is left exactly as it was");
    assert.equal(get(r, atKey).creds.v, undefined);

    __setRedisForTests(r);
    __setClockForTests(() => LEGACY_CUTOFF_MS + 1);
    assert.equal(await quiet(() => lookupAccessToken(at)), null, "the spliced v1 blob dies at the cutoff; users re-auth");

    // --delete removes v1 records now instead.
    __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);
    const del = await migrateLegacy(r, { apply: true, mode: "delete" });
    assert.equal(del.deleted, 1);
    assert.equal(r.data.has(atKey), false);
  });
});

test("aad: oauth-legacy-seal with the wrong KEK skips unopenable records, deletes nothing, writes nothing", async () => {
  const r = oauthRedis();
  const v1Key = KEY.access(sha256hex("1".repeat(64)));
  put(r, v1Key, v1Record()); // sealed under TEST_KEK_HEX
  r.ttls.set(v1Key, 100);
  // a v2 record under the right KEK, and a legacy raw record that would otherwise be sealed
  await withEnv(KEK, async () => {
    __setRedisForTests(r);
    await mintTokens({ client_id: "cli_x", scope: "mcp", space: "s", backend: { kind: "redis", uri: "rediss://h" } });
    __setRedisForTests(null);
  });
  const legacyKey = `lm:oauth:token:${"7".repeat(64)}`;
  put(r, legacyKey, { client_id: "c", space: "s", upstash_token: "T", expires_at: 9e9 });
  __setClockForTests(() => LEGACY_CUTOFF_MS - 1000);
  const before = JSON.stringify([...r.data.entries()]);
  await withEnv({ ...KEK, LOGMEM_OAUTH_KEK: "ff".repeat(32) }, async () => {
    const logs = [];
    const rep = await migrateLegacy(r, { apply: true, log: (m) => logs.push(m) });
    assert.equal(rep.aborted, true);
    assert.ok(rep.unopenable >= 3, `v1 + v2 at + v2 rt counted (got ${rep.unopenable})`);
    assert.equal(rep.deleted, 0);
    assert.equal(rep.sealed, 0);
    assert.ok(rep.actions.every((a) => a.action === "skip-unopenable"));
    assert.equal(JSON.stringify([...r.data.entries()]), before, "nothing deleted or written");
    assert.match(logs.join("\n"), /Check the KEK/);
  });
});

test("aad: oauth-legacy-seal CLI exits non-zero when records were skipped", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/oauth-legacy-seal.mjs", import.meta.url), "utf8");
  assert.match(src, /report\.unopenable > 0[\s\S]*process\.exitCode = 2/);
  assert.match(src, /--confirm-unverified-kek/);
  assert.match(src, /report\.kekUnverified && report\.aborted[\s\S]*process\.exitCode = 2/);
});

test("aad: legacy raw records are sealed with a clamped TTL; expires_at is never extended", async () => {
  await withEnv(KEK, async () => {
    const r = oauthRedis();
    const raw = "8".repeat(64);
    const nowS = Math.floor(Date.now() / 1000);
    put(r, `lm:oauth:token:${raw}`, { client_id: "c", space: "s", upstash_token: "T", expires_at: nowS + 100 });
    r.ttls.set(`lm:oauth:token:${raw}`, 999999); // forged long TTL
    const expired = "6".repeat(64);
    put(r, `lm:oauth:token:${expired}`, { client_id: "c", space: "s", upstash_token: "T", expires_at: nowS - 5 });
    r.ttls.set(`lm:oauth:token:${expired}`, 500);
    // Raw-only keyspace: nothing sealed can prove the KEK, so --apply needs the confirm flag.
    const rep = await migrateLegacy(r, { apply: true, confirmUnverifiedKek: true });
    const k = KEY.access(sha256hex(raw));
    assert.ok(r.ttls.get(k) <= 100 && r.ttls.get(k) > 90, `ttl ${r.ttls.get(k)}`);
    assert.equal(get(r, k).expires_at, nowS + 100);
    assert.equal(r.data.has(KEY.access(sha256hex(expired))), false, "already-expired legacy record is not resurrected");
    assert.equal(rep.sealed, 1);
  });
});
