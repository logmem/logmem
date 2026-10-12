// OAuth storage on the deploy-owner Redis (LOGMEM_DEPLOY_REST_URL/_TOKEN).
// In production (VERCEL_ENV=production) those are required: there is no
// fallback to UPSTASH_REDIS_REST_URL, so OAuth records never land in a shared
// user-data Redis by accident. Elsewhere the UPSTASH_* fallback stays for dev.
//
// Keys (all under lm:oauth:, outside every space). Secrets are never key
// material: every token/code key is sha256(value) in hex, and hashed records
// live under prefixes that legacy raw-keyed records never used, so a stored
// hash can never be presented as a bearer and hit a legacy lookup.
//   lm:oauth:client:<client_id>     — DCR client (TTL 30d, slid on token issuance)
//   lm:oauth:code:<sha256(code)>    — pending auth code (TTL 600s)
//   lm:oauth:at:<sha256(access)>    — access token (TTL 12h)
//   lm:oauth:rt:<sha256(refresh)>   — refresh token (TTL 30d)
//   lm:oauth:rtg:<sha256(refresh)>  — just-rotated refresh token: reusable once
//                                     within 60s; carries the hashes of the
//                                     tokens minted from the first use, which a
//                                     grace use revokes
//   <key>:used                      — consume lock when GETDEL is unavailable
//
// Legacy (pre-hash) keys, read-only until LEGACY_CUTOFF_MS, and only for
// records WITHOUT a `creds` envelope:
//   lm:oauth:token:<raw access>     lm:oauth:refresh:<raw refresh>
// scripts/oauth-legacy-seal.mjs migrates or deletes them.
//
// Credentials (backend, upstash_url, upstash_token) are sealed with
// AES-256-GCM under LOGMEM_OAUTH_KEK into record.creds =
// {enc:"aes-256-gcm", iv, tag, ct}. Without a KEK, production refuses to
// mint (KekMissingError -> 503); other envs store {enc:"none", warning, data}.
//
// Token contents bind a backend AND a space: the MCP route restores the
// user's Redis creds and pins the connection to that one space.

import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual, hkdfSync } from "node:crypto";
import { restEndpoint } from "../../../src/lib/redis-rest.mjs";

export const KEY = {
  client: (id) => `lm:oauth:client:${id}`,
  code: (h) => `lm:oauth:code:${h}`,
  access: (h) => `lm:oauth:at:${h}`,
  refresh: (h) => `lm:oauth:rt:${h}`,
  refreshGrace: (h) => `lm:oauth:rtg:${h}`,
  // TODO(remove after LEGACY_CUTOFF_MS): pre-hash raw-token keys.
  legacyAccess: (t) => `lm:oauth:token:${t}`,
  legacyRefresh: (t) => `lm:oauth:refresh:${t}`,
};

export const TTL = {
  code: 600, // 10 min
  access: 60 * 60 * 12, // 12 hr — 1 hr caused re-auth churn when clients missed a refresh
  refresh: 60 * 60 * 24 * 30, // 30 d
  client: 60 * 60 * 24 * 30, // 30 d, slid on every successful token issuance
  refreshGrace: 60, // previous refresh token reusable once within 60s
};

/** Legacy raw-key reads stop at this instant (2026-10-26T00:00:00Z). */
export const LEGACY_CUTOFF_MS = Date.UTC(2026, 9, 26);

const DEPLOY_TIMEOUT_MS = 5000;
const AAD = Buffer.from("logmem-oauth-creds-v1");
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

// ───── Errors ─────

export class KekMissingError extends Error {
  constructor() {
    super("LOGMEM_OAUTH_KEK is not configured; refusing to store credentials in production");
    this.name = "KekMissingError";
    this.status = 503;
  }
}

export class StorageConfigError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "StorageConfigError";
    this.status = 503;
  }
}

const isProd = (env = process.env) => env.VERCEL_ENV === "production";

// ───── Test seams ─────

let testRunner = null;
let clock = () => Date.now();
/** Tests only: route all storage calls through `runner` (e.g. memory-redis). Pass null to reset. */
export function __setRedisForTests(runner) {
  testRunner = runner;
  getdelSupported = undefined;
}
/** Tests only: replace the wall clock used for the legacy cutoff. Pass null to reset. */
export function __setClockForTests(fn) {
  clock = fn || (() => Date.now());
}
const legacyOpen = () => clock() < LEGACY_CUTOFF_MS;

// ───── Deploy Redis runner ─────

/** Runner for the deploy-owner Redis. Exported for scripts/oauth-legacy-seal.mjs. */
export function deployRedis() {
  if (testRunner) return testRunner;
  const env = process.env;
  let url = env.LOGMEM_DEPLOY_REST_URL;
  let token = env.LOGMEM_DEPLOY_REST_TOKEN;
  if (!isProd(env)) {
    url = url || env.UPSTASH_REDIS_REST_URL;
    token = token || env.UPSTASH_REDIS_REST_TOKEN;
  }
  if (!url || !token) {
    throw new StorageConfigError(
      isProd(env)
        ? "production requires LOGMEM_DEPLOY_REST_URL/_TOKEN for OAuth storage"
        : "deploy missing LOGMEM_DEPLOY_REST_URL/_TOKEN",
    );
  }
  return async (...cmd) => {
    const res = await fetch(restEndpoint(url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body; handled below without echoing it
    }
    if (body && body.error) throw new Error(`redis-rest ${String(body.error).slice(0, 120)}`);
    if (!res.ok) throw new Error(`redis-rest HTTP ${res.status}`);
    if (!body) throw new Error("redis-rest: non-JSON response");
    return body.result;
  };
}

// ───── Helpers ─────

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function sha256hex(input) {
  return createHash("sha256").update(String(input)).digest("hex");
}

export function sha256base64url(input) {
  return createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Constant-time string equality: hash both sides so timingSafeEqual sees equal-length buffers. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const isRawToken = (t) => /^[0-9a-f]{64}$/.test(t);

// ───── Credential envelope ─────

/** Parse LOGMEM_OAUTH_KEK (32 bytes, hex or base64). null if unset; throws if malformed. */
export function loadKek(env = process.env) {
  const raw = String(env.LOGMEM_OAUTH_KEK || "").trim();
  if (!raw) return null;
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buf || buf.length !== 32) {
    throw new StorageConfigError("LOGMEM_OAUTH_KEK must be 32 bytes, hex or base64");
  }
  return buf;
}

/** Throws KekMissingError when tokens cannot be minted (production without a KEK). */
export function assertKekReady(env = process.env) {
  if (!loadKek(env) && isProd(env)) throw new KekMissingError();
}

let ephemeralCsrfKey = null;
/**
 * HMAC key for consent-page CSRF tokens: HKDF(KEK, "logmem-oauth-csrf-v1").
 * Without a KEK (non-production only; production refuses earlier) a
 * per-process random key is used.
 */
export function csrfKey(env = process.env) {
  const kek = loadKek(env);
  if (kek) return Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), "logmem-oauth-csrf-v1", 32));
  if (!ephemeralCsrfKey) ephemeralCsrfKey = randomBytes(32);
  return ephemeralCsrfKey;
}

export function hmacHex(key, data) {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Seal the credential blob. Throws KekMissingError in production without a KEK. */
export function sealCreds(creds, env = process.env) {
  const kek = loadKek(env);
  if (!kek) {
    if (isProd(env)) throw new KekMissingError();
    return { enc: "none", warning: "LOGMEM_OAUTH_KEK unset: credentials stored unencrypted (non-production only)", data: creds };
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  return { enc: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** Inverse of sealCreds. Throws on a missing/wrong KEK or a malformed/tampered envelope. */
export function openCreds(envelope, env = process.env) {
  if (!envelope || typeof envelope !== "object") throw new Error("no credential envelope");
  if (envelope.enc === "none") {
    if (isProd(env)) throw new KekMissingError();
    return envelope.data;
  }
  if (envelope.enc !== "aes-256-gcm") throw new Error("unknown credential envelope");
  const kek = loadKek(env);
  if (!kek) throw new KekMissingError();
  const iv = Buffer.from(String(envelope.iv), "base64");
  const tag = Buffer.from(String(envelope.tag), "base64");
  if (iv.length !== GCM_IV_BYTES) throw new Error("bad envelope iv length");
  if (tag.length !== GCM_TAG_BYTES) throw new Error("bad envelope tag length");
  const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(String(envelope.ct), "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

const CRED_FIELDS = new Set(["backend", "upstash_url", "upstash_token"]);

/** Move credential fields out of `rec` into a sealed `creds` envelope. */
export function sealRecord(rec) {
  const creds = {};
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (CRED_FIELDS.has(k)) creds[k] = v ?? null;
    else out[k] = v;
  }
  out.creds = sealCreds(creds);
  return out;
}

/**
 * Restore the plaintext shape callers expect ({...rec, backend, upstash_url,
 * upstash_token}). Records without `creds` pass through unchanged (callers
 * only accept those from legacy keys). Returns null if the envelope cannot
 * be opened (rotated KEK, tampering).
 */
function openRecord(rec) {
  if (!rec || !rec.creds) return rec;
  try {
    const creds = openCreds(rec.creds);
    const { creds: _drop, ...rest } = rec;
    return { ...rest, ...creds };
  } catch (e) {
    console.warn(`[oauth] could not open credential envelope: ${e.name}`);
    return null;
  }
}

/** Hashed keys must hold sealed records; anything else is ignored. */
const openSealed = (rec) => (rec && rec.creds ? openRecord(rec) : null);
/** Legacy keys only ever held unsealed records; a sealed one there is foreign. */
const openLegacy = (rec) => (rec && !rec.creds ? rec : null);

export const parse = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// ───── Atomic single-use consume ─────

let getdelSupported; // undefined = unknown, then true/false for this process

/**
 * Atomically read-and-delete `key`. Prefers GETDEL; if the runner rejects it,
 * takes a SET NX lock on `<key>:used` (TTL = the record's remaining TTL, so the
 * lock can never expire while the record is still readable) so only one
 * caller ever gets the value.
 */
async function consumeOnce(r, key, fallbackTtl) {
  if (getdelSupported !== false) {
    try {
      const v = await r("GETDEL", key);
      getdelSupported = true;
      return v;
    } catch (e) {
      if (getdelSupported === true) throw e; // GETDEL worked before; this is a real error
      getdelSupported = false;
    }
  }
  const remaining = Number(await r("TTL", key));
  if (remaining === -2) return null; // no such key
  const lockTtl = remaining > 0 ? remaining : fallbackTtl;
  const lock = await r("SET", `${key}:used`, "1", "NX", "EX", String(lockTtl));
  if (lock !== "OK") return null; // someone else already consumed it
  const v = await r("GET", key);
  if (v != null) await r("DEL", key);
  return v;
}

// ───── Clients ─────

export async function registerClient(meta) {
  const r = deployRedis();
  const client_id = `cli_${randomToken(8)}`;
  const client_secret = meta.token_endpoint_auth_method === "client_secret_post" ? randomToken(24) : null;
  const record = {
    client_id,
    client_secret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: meta.redirect_uris || [],
    grant_types: meta.grant_types || ["authorization_code", "refresh_token"],
    response_types: meta.response_types || ["code"],
    token_endpoint_auth_method: meta.token_endpoint_auth_method || "none",
    client_name: meta.client_name || null,
    scope: meta.scope || "mcp",
  };
  await r("SET", KEY.client(client_id), JSON.stringify(record), "EX", String(TTL.client));
  return record;
}

export async function getClient(client_id) {
  if (!client_id || typeof client_id !== "string" || client_id.length > 64) return null;
  const r = deployRedis();
  return parse(await r("GET", KEY.client(client_id)));
}

/** Slide the client's 30d TTL. Call only after a successful token issuance. */
export async function touchClient(client_id) {
  if (!client_id) return;
  const r = deployRedis();
  await r("EXPIRE", KEY.client(client_id), String(TTL.client));
}

// ───── Auth codes ─────

export async function saveAuthCode(payload) {
  const r = deployRedis();
  const rec = sealRecord(payload); // throws KekMissingError in prod without a KEK
  const code = randomToken(32);
  await r("SET", KEY.code(sha256hex(code)), JSON.stringify(rec), "EX", String(TTL.code));
  return code;
}

export async function consumeAuthCode(code) {
  if (!code || typeof code !== "string") return null;
  const r = deployRedis();
  return openSealed(parse(await consumeOnce(r, KEY.code(sha256hex(code)), TTL.code)));
}

// ───── Access + refresh tokens ─────

export async function mintTokens({ client_id, scope, upstash_url, upstash_token, backend, sub, space }) {
  const r = deployRedis();
  const access = randomToken(32);
  const refresh = randomToken(32);
  const issued_at = Math.floor(Date.now() / 1000);

  // `backend` is the generic credential blob ({kind:'upstash',url,token} or
  // {kind:'redis',uri}); upstash_url/_token stay populated for the upstash
  // kind so opened records remain readable by pre-refactor callers.
  // sealRecord throws KekMissingError before anything is written.
  const accessRecord = sealRecord({ client_id, scope, sub, space, upstash_url, upstash_token, backend, issued_at, expires_at: issued_at + TTL.access });
  const refreshRecord = sealRecord({ client_id, scope, sub, space, upstash_url, upstash_token, backend, issued_at });

  await r("SET", KEY.access(sha256hex(access)), JSON.stringify(accessRecord), "EX", String(TTL.access));
  await r("SET", KEY.refresh(sha256hex(refresh)), JSON.stringify(refreshRecord), "EX", String(TTL.refresh));

  return { access_token: access, token_type: "Bearer", expires_in: TTL.access, refresh_token: refresh, scope };
}

export async function lookupAccessToken(access_token) {
  if (!access_token || typeof access_token !== "string") return null;
  const r = deployRedis();
  const rec = parse(await r("GET", KEY.access(sha256hex(access_token))));
  if (rec) return openSealed(rec);
  // Backward compat: tokens minted before hashing were keyed by the raw value.
  // Only unsealed records count, and only until the cutoff.
  // TODO(remove after LEGACY_CUTOFF_MS): drop this legacy raw-key lookup.
  if (legacyOpen() && isRawToken(access_token)) {
    return openLegacy(parse(await r("GET", KEY.legacyAccess(access_token))));
  }
  return null;
}

/**
 * Single-use refresh, checked against `client_id` BEFORE anything is
 * consumed so a mismatched client cannot burn someone else's token.
 *
 * Returns null (invalid/used), { mismatch: true }, or
 * { rec, grace } where grace=true means this was the one allowed reuse inside
 * the 60s window; in that case the tokens minted from the first use have
 * already been revoked and a "refresh_grace_used" event logged.
 */
export async function consumeRefresh(refresh_token, client_id) {
  if (!refresh_token || typeof refresh_token !== "string") return null;
  const r = deployRedis();
  const h = sha256hex(refresh_token);

  // 1. Live refresh token.
  const peek = parse(await r("GET", KEY.refresh(h)));
  if (peek && peek.creds) {
    if (peek.client_id !== client_id) return { mismatch: true };
    const raw = await consumeOnce(r, KEY.refresh(h), TTL.refresh);
    const rec = openSealed(parse(raw));
    if (rec) {
      await r("SET", KEY.refreshGrace(h), JSON.stringify({ rec: raw, children: null }), "EX", String(TTL.refreshGrace));
      return { rec, grace: false };
    }
  }

  // 2. Grace reuse of a just-rotated token.
  const gpeek = parse(await r("GET", KEY.refreshGrace(h)));
  if (gpeek) {
    const graceRec = parse(gpeek.rec);
    if (!graceRec || graceRec.client_id !== client_id) return { mismatch: true };
    const g = parse(await consumeOnce(r, KEY.refreshGrace(h), TTL.refreshGrace));
    const rec = g && openSealed(parse(g.rec));
    if (rec) {
      let revoked = 0;
      const ch = g.children || {};
      if (ch.at) revoked += Number(await r("DEL", KEY.access(ch.at))) || 0;
      if (ch.rt) revoked += Number(await r("DEL", KEY.refresh(ch.rt))) || 0;
      console.warn(JSON.stringify({ event: "refresh_grace_used", client_id: rec.client_id, sub: rec.sub ?? null, space: rec.space ?? null, children_revoked: revoked, ts: new Date().toISOString() }));
      return { rec, grace: true };
    }
  }

  // 3. Legacy raw-keyed refresh token (unsealed records only, until the cutoff).
  // TODO(remove after LEGACY_CUTOFF_MS)
  if (legacyOpen() && isRawToken(refresh_token)) {
    const lpeek = openLegacy(parse(await r("GET", KEY.legacyRefresh(refresh_token))));
    if (lpeek) {
      if (lpeek.client_id !== client_id) return { mismatch: true };
      const rec = openLegacy(parse(await consumeOnce(r, KEY.legacyRefresh(refresh_token), TTL.refresh)));
      if (rec) return { rec, grace: false };
    }
  }
  return null;
}

/**
 * After minting from a refresh token, record the new tokens' hashes on its
 * grace record so a later grace reuse can revoke them.
 */
export async function linkRefreshChildren(refresh_token, minted) {
  const r = deployRedis();
  const gk = KEY.refreshGrace(sha256hex(refresh_token));
  const g = parse(await r("GET", gk));
  if (!g) return;
  const ttl = Number(await r("TTL", gk));
  g.children = { at: sha256hex(minted.access_token), rt: sha256hex(minted.refresh_token) };
  await r("SET", gk, JSON.stringify(g), "EX", String(ttl > 0 ? ttl : TTL.refreshGrace));
}

export async function revokeAccessToken(access_token) {
  if (!access_token || typeof access_token !== "string") return;
  const r = deployRedis();
  await r("DEL", KEY.access(sha256hex(access_token)));
  // TODO(remove after LEGACY_CUTOFF_MS)
  if (legacyOpen() && isRawToken(access_token)) {
    const lk = KEY.legacyAccess(access_token);
    if (openLegacy(parse(await r("GET", lk)))) await r("DEL", lk);
  }
}
