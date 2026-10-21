// OAuth storage on the deploy-owner Redis: LOGMEM_DEPLOY_REDIS_URI (rediss://,
// any official Redis), or LOGMEM_DEPLOY_REST_URL/_TOKEN (an HTTP Redis REST bridge).
// Fail closed by default: those are required, and there is no fallback to
// UPSTASH_REDIS_REST_URL, so OAuth records never land in a shared user-data
// Redis by accident. The UPSTASH_* fallback and plaintext creds (no KEK) are
// allowed only in local dev (see insecureAllowed): VERCEL_ENV "development",
// no VERCEL_ENV with NODE_ENV development/test, or LOGMEM_OAUTH_ALLOW_INSECURE=1.
// Preview deployments fail closed like production, and production ignores
// the opt-in flag.
//
// Keys (all under lm:oauth:, outside every space). Secrets are never key
// material: every token/code key is sha256(value) in hex, and hashed records
// live under prefixes that legacy raw-keyed records never used, so a stored
// hash can never be presented as a bearer and hit a legacy lookup.
//   lm:oauth:client:<client_id>     — DCR client (TTL 30d, slid on token issuance)
//   lm:oauth:code:<sha256(code)>    — pending auth code (TTL 600s)
//   lm:oauth:at:<sha256(access)>    — access token (TTL 12h)
//   lm:oauth:rt:<sha256(refresh)>   — refresh token (TTL 30d)
//   lm:oauth:rtg:<sha256(refresh)>  — just-rotated refresh token (60s reuse-
//                                     detection window): carries the hashes of
//                                     the tokens minted from the first use. A
//                                     second presentation inside the window is
//                                     reuse (RFC 9700 4.14): the whole family is
//                                     revoked and invalid_grant returned
//   lm:oauth:rtg:<sha256(refresh)>:revoked — per-token revoked marker (60s)
//   lm:oauth:fam:<fid>              — SET of "at:<hash>" / "rt:<hash>" for every
//                                     token ever minted for one grant (TTL 30d,
//                                     slid on each mint). Every record carries
//                                     `fid`, so reuse detection revokes ALL of
//                                     the grant's tokens, older ones included
//   lm:oauth:fam:<fid>:revoked      — family-revoked marker (60s), so a first
//                                     use still in flight discards what it mints
//   <key>:used                      — consume lock when GETDEL is unavailable
//
// Legacy (pre-hash) keys, read-only until LEGACY_CUTOFF_MS, and only for
// records WITHOUT a `creds` envelope:
//   lm:oauth:token:<raw access>     lm:oauth:refresh:<raw refresh>
// scripts/oauth-legacy-seal.mjs migrates or deletes them.
//
// Credentials (backend, upstash_url, upstash_token) are sealed with
// AES-256-GCM under LOGMEM_OAUTH_KEK into record.creds =
// {enc:"aes-256-gcm", v:2, iv, tag, ct}. The v2 AAD binds the envelope to its
// record: "logmem-oauth-creds-v2|<kind>|<key hash>|<canonical JSON of every
// plaintext field>" (client_id, space, sub, scope, expires_at, issued_at,
// redirect_uri, code_challenge, ...). So a sealed blob copied under another
// key, or next to edited plaintext fields, fails to open. Envelopes without
// `v` were sealed with the constant v1 AAD. Access-token lookup still opens
// them until LEGACY_CUTOFF_MS. Refresh-token and authorization-code
// consumption never mint from them: a v1 blob copied under an attacker-chosen
// key would otherwise become a fresh v2 grant that still refreshes after the
// cutoff. scripts/oauth-legacy-seal.mjs does not re-seal v1 envelopes.
// Without a KEK, minting is refused (KekMissingError -> 503) unless
// insecureAllowed(); local dev then stores {enc:"none", warning, data}.
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
  refreshRevoked: (h) => `lm:oauth:rtg:${h}:revoked`,
  family: (fid) => `lm:oauth:fam:${fid}`,
  familyRevoked: (fid) => `lm:oauth:fam:${fid}:revoked`,
  // TODO(remove after LEGACY_CUTOFF_MS): pre-hash raw-token keys.
  legacyAccess: (t) => `lm:oauth:token:${t}`,
  legacyRefresh: (t) => `lm:oauth:refresh:${t}`,
};

export const TTL = {
  code: 600, // 10 min
  access: 60 * 60 * 12, // 12 hr — 1 hr caused re-auth churn when clients missed a refresh
  refresh: 60 * 60 * 24 * 30, // 30 d
  client: 60 * 60 * 24 * 30, // 30 d, slid on every successful token issuance
  refreshGrace: 60, // reuse-detection window for a just-rotated refresh token
};

/** Legacy raw-key reads stop at this instant (2026-10-26T00:00:00Z). */
export const LEGACY_CUTOFF_MS = Date.UTC(2026, 9, 26);

const DEPLOY_TIMEOUT_MS = 5000;
const AAD_V1 = Buffer.from("logmem-oauth-creds-v1"); // TODO(remove after LEGACY_CUTOFF_MS)
const ENVELOPE_V = 2;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

// ───── Errors ─────

export class KekMissingError extends Error {
  constructor() {
    super("LOGMEM_OAUTH_KEK is not configured; refusing to store credentials (set it, or LOGMEM_OAUTH_ALLOW_INSECURE=1 for local dev)");
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

/**
 * Plaintext creds and the UPSTASH_* storage fallback are local-dev only:
 *   - VERCEL_ENV === "development" (vercel dev), or
 *   - VERCEL_ENV unset/empty AND NODE_ENV is "development" or "test", or
 *   - LOGMEM_OAUTH_ALLOW_INSECURE=1 outside production.
 * Never in production, whatever the flag says. Preview, custom environments
 * and a bare process with no VERCEL_ENV/NODE_ENV all fail closed.
 */
export function insecureAllowed(env = process.env) {
  if (isProd(env)) return false;
  if (env.LOGMEM_OAUTH_ALLOW_INSECURE === "1") return true;
  if (env.VERCEL_ENV === "development") return true;
  return !env.VERCEL_ENV && (env.NODE_ENV === "development" || env.NODE_ENV === "test");
}

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
/** Current time on the storage clock (test-overridable). For scripts/oauth-legacy-seal.mjs. */
export const storageNow = () => clock();

// ───── Deploy Redis runner ─────

/** Runner for the deploy-owner Redis. Exported for scripts/oauth-legacy-seal.mjs. */
export function deployRedis() {
  if (testRunner) return testRunner;
  const env = process.env;
  const fallback = insecureAllowed(env);
  // Official Redis over TCP first. TLS (rediss://) is required outside local dev.
  const uri = String(env.LOGMEM_DEPLOY_REDIS_URI || "").trim();
  if (uri) {
    if (!/^rediss:\/\//i.test(uri) && !(fallback && /^redis:\/\//i.test(uri))) {
      throw new StorageConfigError("LOGMEM_DEPLOY_REDIS_URI must start with rediss:// (TLS)");
    }
    return async (...cmd) => {
      const { nativeRedisCall } = await import("../../../src/lib/redis-native.mjs");
      return nativeRedisCall(uri, ...cmd);
    };
  }
  let url = env.LOGMEM_DEPLOY_REST_URL;
  let token = env.LOGMEM_DEPLOY_REST_TOKEN;
  if (fallback) {
    url = url || env.UPSTASH_REDIS_REST_URL;
    token = token || env.UPSTASH_REDIS_REST_TOKEN;
  }
  if (!url || !token) {
    throw new StorageConfigError(
      fallback
        ? "deploy missing LOGMEM_DEPLOY_REDIS_URI or LOGMEM_DEPLOY_REST_URL/_TOKEN"
        : `${env.VERCEL_ENV || "this environment"} requires LOGMEM_DEPLOY_REDIS_URI (rediss://) or LOGMEM_DEPLOY_REST_URL/_TOKEN for OAuth storage`,
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

/** Throws KekMissingError when tokens cannot be minted (no KEK outside local dev). */
export function assertKekReady(env = process.env) {
  if (!loadKek(env) && !insecureAllowed(env)) throw new KekMissingError();
}

let ephemeralCsrfKey = null;
/**
 * HMAC key for consent-page CSRF tokens: HKDF(KEK, "logmem-oauth-csrf-v1").
 * Without a KEK (local dev only; everything else refuses earlier) a
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

/** Stable JSON: object keys sorted at every level, so the AAD is deterministic. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * v2 AAD: binds the envelope to its record kind ("code" | "access" |
 * "refresh"), the sha256 key hash it is stored under, and every plaintext
 * field stored beside it.
 */
export function recordAad(kind, keyHash, plain) {
  if (!kind || !/^[0-9a-f]{64}$/.test(String(keyHash))) throw new Error("recordAad needs a kind and a sha256 key hash");
  return Buffer.from(`logmem-oauth-creds-v2|${kind}|${keyHash}|${canonical(plain)}`, "utf8");
}

/** Seal the credential blob under `aad` (see recordAad). Throws KekMissingError without a KEK outside local dev. */
export function sealCreds(creds, aad, env = process.env) {
  if (!Buffer.isBuffer(aad) || aad.length === 0) throw new Error("sealCreds requires record-bound AAD");
  const kek = loadKek(env);
  if (!kek) {
    if (!insecureAllowed(env)) throw new KekMissingError();
    return { enc: "none", warning: "LOGMEM_OAUTH_KEK unset: credentials stored unencrypted (local dev only)", data: creds };
  }
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  return { enc: "aes-256-gcm", v: ENVELOPE_V, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/**
 * Inverse of sealCreds. Throws on a missing/wrong KEK, a malformed/tampered
 * envelope, or an AAD mismatch (blob moved to another key or record). A
 * legacy envelope (no `v`, constant v1 AAD) opens only before LEGACY_CUTOFF_MS.
 * That path is for access-token lookup. consumeRefresh and consumeAuthCode
 * refuse v1 outright so a copied blob cannot be exchanged for a v2 grant.
 */
export function openCreds(envelope, aad, env = process.env) {
  if (!envelope || typeof envelope !== "object") throw new Error("no credential envelope");
  if (envelope.enc === "none") {
    if (!insecureAllowed(env)) throw new KekMissingError();
    return envelope.data;
  }
  if (envelope.enc !== "aes-256-gcm") throw new Error("unknown credential envelope");
  let useAad;
  if (envelope.v === ENVELOPE_V) {
    if (!Buffer.isBuffer(aad) || aad.length === 0) throw new Error("openCreds requires record-bound AAD");
    useAad = aad;
  } else if (envelope.v === undefined) {
    // TODO(remove after LEGACY_CUTOFF_MS): constant-AAD v1 envelopes.
    if (!legacyOpen()) throw new Error("v1 credential envelope past the legacy cutoff");
    useAad = AAD_V1;
  } else {
    throw new Error("unknown credential envelope version");
  }
  const kek = loadKek(env);
  if (!kek) throw new KekMissingError();
  const iv = Buffer.from(String(envelope.iv), "base64");
  const tag = Buffer.from(String(envelope.tag), "base64");
  if (iv.length !== GCM_IV_BYTES) throw new Error("bad envelope iv length");
  if (tag.length !== GCM_TAG_BYTES) throw new Error("bad envelope tag length");
  const decipher = createDecipheriv("aes-256-gcm", kek, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(useAad);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(String(envelope.ct), "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

const CRED_FIELDS = new Set(["backend", "upstash_url", "upstash_token"]);

/**
 * Move credential fields out of `rec` into a sealed `creds` envelope bound to
 * (kind, keyHash, the remaining plaintext fields). The caller must already
 * know the key hash, so generate the token/code before sealing.
 */
export function sealRecord(rec, kind, keyHash) {
  const creds = {};
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "creds") continue;
    if (CRED_FIELDS.has(k)) creds[k] = v ?? null;
    else out[k] = v;
  }
  out.creds = sealCreds(creds, recordAad(kind, keyHash, out));
  return out;
}

/**
 * Restore the plaintext shape callers expect ({...rec, backend, upstash_url,
 * upstash_token}). Records without `creds` pass through unchanged (callers
 * only accept those from legacy keys). Returns null if the envelope cannot
 * be opened (rotated KEK, tampering, wrong key/record binding, v1 past cutoff).
 */
function openRecord(rec, kind, keyHash) {
  if (!rec || !rec.creds) return rec;
  try {
    const { creds: envelope, ...rest } = rec;
    const creds = openCreds(envelope, recordAad(kind, keyHash, rest));
    return { ...rest, ...creds };
  } catch (e) {
    console.warn(`[oauth] could not open credential envelope: ${e.name}`);
    return null;
  }
}

/** Is this a sealed record still on the constant-AAD v1 envelope? */
export const isV1Sealed = (rec) => !!(rec && rec.creds && rec.creds.enc === "aes-256-gcm" && rec.creds.v === undefined);

/**
 * Migration preflight: can this sealed record be opened with the current KEK
 * (and, for v1, before the cutoff)? Never returns the plaintext.
 */
export function canOpenRecord(rec, kind, keyHash) {
  if (!rec || !rec.creds) return false;
  const w = console.warn;
  console.warn = () => {};
  try {
    return openRecord(rec, kind, keyHash) !== null;
  } finally {
    console.warn = w;
  }
}

/** Hashed keys must hold sealed records; anything else is ignored. */
const openSealed = (rec, kind, keyHash) => (rec && rec.creds ? openRecord(rec, kind, keyHash) : null);
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

/** Auth methods that get a client secret at registration. */
export const SECRET_METHODS = new Set(["client_secret_post", "client_secret_basic"]);

export async function registerClient(meta) {
  const r = deployRedis();
  const client_id = `cli_${randomToken(8)}`;
  const client_secret = SECRET_METHODS.has(meta.token_endpoint_auth_method) ? randomToken(24) : null;
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
  const code = randomToken(32);
  const h = sha256hex(code);
  const rec = sealRecord(payload, "code", h); // throws KekMissingError in prod without a KEK
  await r("SET", KEY.code(h), JSON.stringify(rec), "EX", String(TTL.code));
  return code;
}

export async function consumeAuthCode(code) {
  if (!code || typeof code !== "string") return null;
  const r = deployRedis();
  const h = sha256hex(code);
  const stored = parse(await consumeOnce(r, KEY.code(h), TTL.code));
  // Constant-AAD v1 opens under any key until the cutoff. Burn the code and
  // return nothing so /api/oauth/token answers invalid_grant and mints no v2 grant.
  if (isV1Sealed(stored)) return null;
  return openSealed(stored, "code", h);
}

// ───── Access + refresh tokens ─────

const isFid = (f) => typeof f === "string" && /^[0-9a-f]{32}$/.test(f);

/**
 * Mint an access + refresh pair. `fid` is the grant's family id: omit it for
 * a new grant (auth-code exchange), pass the refresh record's fid on rotation.
 */
export async function mintTokens({ client_id, scope, upstash_url, upstash_token, backend, sub, space, fid }) {
  const r = deployRedis();
  const family = isFid(fid) ? fid : randomToken(16);
  const access = randomToken(32);
  const refresh = randomToken(32);
  const issued_at = Math.floor(Date.now() / 1000);

  // `backend` is the generic credential blob ({kind:'upstash',url,token} or
  // {kind:'redis',uri}); upstash_url/_token stay populated for the upstash
  // kind so opened records remain readable by pre-refactor callers.
  // sealRecord throws KekMissingError before anything is written.
  const hAt = sha256hex(access);
  const hRt = sha256hex(refresh);
  const accessRecord = sealRecord({ client_id, scope, sub, space, upstash_url, upstash_token, backend, issued_at, expires_at: issued_at + TTL.access, fid: family }, "access", hAt);
  // sibling_at lets reuse detection revoke the access token minted alongside.
  const refreshRecord = sealRecord({ client_id, scope, sub, space, upstash_url, upstash_token, backend, issued_at, sibling_at: hAt, fid: family }, "refresh", hRt);

  await r("SET", KEY.access(hAt), JSON.stringify(accessRecord), "EX", String(TTL.access));
  await r("SET", KEY.refresh(hRt), JSON.stringify(refreshRecord), "EX", String(TTL.refresh));
  await r("SADD", KEY.family(family), `at:${hAt}`, `rt:${hRt}`);
  await r("EXPIRE", KEY.family(family), String(TTL.refresh));
  if (backend?.kind === "managed") await recordManagedApp(r, { family, isNew: !isFid(fid), client_id, backend });

  return { access_token: access, token_type: "Bearer", expires_in: TTL.access, refresh_token: refresh, scope };
}

// ───── Managed connected apps (one-click connect, task 5) ─────
// One record per grant family, so the account owner can see and disconnect
// each app. The record holds no token and no credential.
//   lm:account:app:{fid}       — { fid, tenant, agent, client_id, client_name, created_at, last_used }
//   lm:account:apps:{tenant}   — SET of fids
const APP_KEY = { app: (fid) => `lm:account:app:${fid}`, apps: (tenant) => `lm:account:apps:${tenant}` };

async function recordManagedApp(r, { family, isNew, client_id, backend }) {
  const now = Math.floor(Date.now() / 1000);
  const prev = parse(await r("GET", APP_KEY.app(family)));
  if (prev) {
    await r("SET", APP_KEY.app(family), JSON.stringify({ ...prev, last_used: now }), "EX", String(TTL.refresh));
    return;
  }
  if (!isNew && !prev) return; // a refresh of a grant that was disconnected: do not resurrect it
  let client_name = null;
  try {
    client_name = (await getClient(client_id))?.client_name || null;
  } catch {
    // name is cosmetic
  }
  const rec = { fid: family, tenant: backend.tenant, agent: backend.agent, client_id, client_name, created_at: now, last_used: now };
  await r("SET", APP_KEY.app(family), JSON.stringify(rec), "EX", String(TTL.refresh));
  await r("SADD", APP_KEY.apps(backend.tenant), family);
}

/** The connected apps of one managed tenant, newest use first. */
export async function listManagedApps(tenant) {
  const r = deployRedis();
  const out = [];
  for (const fid of (await r("SMEMBERS", APP_KEY.apps(tenant))) || []) {
    if (!isFid(fid)) continue;
    const rec = parse(await r("GET", APP_KEY.app(fid)));
    if (rec && rec.tenant === tenant) out.push(rec);
    else await r("SREM", APP_KEY.apps(tenant), fid); // expired or foreign: drop the stale id
  }
  return out.sort((a, b) => (b.last_used || 0) - (a.last_used || 0));
}

/** Disconnect one app of `tenant`: every token of its grant goes. Returns the app record, or null. */
export async function revokeManagedApp(tenant, fid) {
  if (!isFid(fid)) return null;
  const r = deployRedis();
  const rec = parse(await r("GET", APP_KEY.app(fid)));
  if (!rec || rec.tenant !== tenant) return null;
  await r("SET", KEY.familyRevoked(fid), "1", "EX", String(TTL.refreshGrace));
  await revokeFamilySet(r, fid);
  await r("DEL", APP_KEY.app(fid));
  await r("SREM", APP_KEY.apps(tenant), fid);
  return rec;
}

export async function lookupAccessToken(access_token) {
  if (!access_token || typeof access_token !== "string") return null;
  const r = deployRedis();
  const h = sha256hex(access_token);
  const rec = parse(await r("GET", KEY.access(h)));
  if (rec) return openSealed(rec, "access", h);
  // Backward compat: tokens minted before hashing were keyed by the raw value.
  // Only unsealed records count, and only until the cutoff.
  // TODO(remove after LEGACY_CUTOFF_MS): drop this legacy raw-key lookup.
  if (legacyOpen() && isRawToken(access_token)) {
    return openLegacy(parse(await r("GET", KEY.legacyAccess(access_token))));
  }
  return null;
}

const MAX_FAMILY_HOPS = 8;

/** Delete every token recorded in the grant's family set. */
async function revokeFamilySet(r, fid) {
  let deleted = 0;
  for (const m of (await r("SMEMBERS", KEY.family(fid))) || []) {
    const [kind, mh] = String(m).split(":");
    if (!/^[0-9a-f]{64}$/.test(mh || "")) continue;
    if (kind === "at") deleted += Number(await r("DEL", KEY.access(mh))) || 0;
    else if (kind === "rt") {
      deleted += Number(await r("DEL", KEY.refresh(mh))) || 0;
      await r("DEL", KEY.refreshGrace(mh));
    }
  }
  await r("DEL", KEY.family(fid));
  return deleted;
}

/**
 * Revoke the whole grant behind the just-rotated token `h`. With a family id
 * (every record minted since fid was introduced), every access and refresh
 * token of the grant goes, older ones included. The chain walk below also
 * covers records without a fid: the access token minted alongside `h`,
 * everything minted from its first use, and onward along further rotations
 * still inside their grace window. Revoked markers go up first, so a first
 * use still in flight discards what it mints (see linkRefreshChildren).
 * Returns how many tokens were deleted.
 */
async function revokeFamily(r, h) {
  let deleted = 0;
  const g0 = parse(await r("GET", KEY.refreshGrace(h)));
  const fid = g0 && parse(g0.rec)?.fid;
  if (isFid(fid)) await r("SET", KEY.familyRevoked(fid), "1", "EX", String(TTL.refreshGrace));
  let cur = h;
  for (let hop = 0; cur && hop < MAX_FAMILY_HOPS; hop++) {
    await r("SET", KEY.refreshRevoked(cur), "1", "EX", String(TTL.refreshGrace));
    const g = parse(await r("GET", KEY.refreshGrace(cur)));
    await r("DEL", KEY.refreshGrace(cur));
    if (!g) break;
    const prev = parse(g.rec);
    if (prev && /^[0-9a-f]{64}$/.test(String(prev.sibling_at))) deleted += Number(await r("DEL", KEY.access(prev.sibling_at))) || 0;
    const ch = g.children || {};
    if (ch.at) deleted += Number(await r("DEL", KEY.access(ch.at))) || 0;
    if (ch.rt) {
      deleted += Number(await r("DEL", KEY.refresh(ch.rt))) || 0;
      await r("SET", KEY.refreshRevoked(ch.rt), "1", "EX", String(TTL.refreshGrace));
    }
    cur = ch.rt;
  }
  // After the chain walk (it needs the grace records the set sweep removes).
  if (isFid(fid)) deleted += await revokeFamilySet(r, fid);
  return deleted;
}

/**
 * Single-use refresh, checked against `client_id` BEFORE anything is
 * consumed so a mismatched client cannot burn someone else's token.
 *
 * Returns null (invalid/used), { mismatch: true }, { reuse: true }, or
 * { rec }. reuse means the token was already rotated within the last 60s:
 * per RFC 9700 4.14 the whole family (the original access token and every
 * token minted from the first use) has been revoked, a
 * "refresh_reuse_detected" event logged, and the caller must answer
 * invalid_grant. Nobody gets fresh tokens from a replay.
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
    const stored = parse(raw);
    // Same rule as consumeAuthCode: never mint from a v1 envelope, and do not
    // leave a grace record that a replay could treat as a real rotation.
    if (isV1Sealed(stored)) return null;
    const rec = openSealed(stored, "refresh", h);
    if (rec) {
      await r("SET", KEY.refreshGrace(h), JSON.stringify({ rec: raw, children: null }), "EX", String(TTL.refreshGrace));
      return { rec };
    }
  }

  // 2. Reuse of a just-rotated token: revoke the family and refuse.
  const gpeek = parse(await r("GET", KEY.refreshGrace(h)));
  if (gpeek) {
    const graceRec = parse(gpeek.rec);
    if (!graceRec || graceRec.client_id !== client_id) return { mismatch: true };
    const revoked = await revokeFamily(r, h);
    console.warn(JSON.stringify({ event: "refresh_reuse_detected", client_id, sub: graceRec.sub ?? null, space: graceRec.space ?? null, tokens_revoked: revoked, ts: new Date().toISOString() }));
    return { reuse: true };
  }

  // 3. Legacy raw-keyed refresh token (unsealed records only, until the cutoff).
  // TODO(remove after LEGACY_CUTOFF_MS)
  if (legacyOpen() && isRawToken(refresh_token)) {
    const lpeek = openLegacy(parse(await r("GET", KEY.legacyRefresh(refresh_token))));
    if (lpeek) {
      if (lpeek.client_id !== client_id) return { mismatch: true };
      const rec = openLegacy(parse(await consumeOnce(r, KEY.legacyRefresh(refresh_token), TTL.refresh)));
      if (rec) return { rec };
    }
  }
  return null;
}

/**
 * After minting from a refresh token, record the new tokens' hashes on its
 * grace record so reuse detection can revoke them. Then check the revoked
 * marker: if reuse was detected while this request was in flight, the tokens
 * just minted are deleted and { revoked: true } is returned (the caller
 * answers invalid_grant). Writing children before reading the marker, while
 * revokeFamily sets the marker before reading children, means at least one
 * side always sees the other.
 */
export async function linkRefreshChildren(refresh_token, minted, fid) {
  const r = deployRedis();
  const h = sha256hex(refresh_token);
  const gk = KEY.refreshGrace(h);
  const g = parse(await r("GET", gk));
  const at = sha256hex(minted.access_token);
  const rt = sha256hex(minted.refresh_token);
  if (g) {
    const ttl = Number(await r("TTL", gk));
    g.children = { at, rt };
    await r("SET", gk, JSON.stringify(g), "EX", String(ttl > 0 ? ttl : TTL.refreshGrace));
  }
  const famRevoked = isFid(fid) ? await r("GET", KEY.familyRevoked(fid)) : null;
  if (famRevoked || (await r("GET", KEY.refreshRevoked(h)))) {
    await r("DEL", KEY.access(at));
    await r("DEL", KEY.refresh(rt));
    return { revoked: true };
  }
  return { revoked: false };
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
