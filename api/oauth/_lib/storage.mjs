// OAuth storage on the deploy-owner Redis (LOGMEM_DEPLOY_REST_URL/_TOKEN).
// In production (VERCEL_ENV=production) those are required: there is no
// fallback to UPSTASH_REDIS_REST_URL, so OAuth records never land in a shared
// user-data Redis by accident. Elsewhere the UPSTASH_* fallback stays for dev.
//
// Keys (all under lm:oauth:, outside every space). Secrets are never key
// material: every token/code key is sha256(value) in hex.
//   lm:oauth:client:<client_id>          — DCR client (TTL 30d, refreshed on use)
//   lm:oauth:code:<sha256(code)>         — pending auth code (TTL 600s)
//   lm:oauth:token:<sha256(access)>      — access token (TTL 12h)
//   lm:oauth:refresh:<sha256(refresh)>   — refresh token (TTL 30d)
//   lm:oauth:refresh-grace:<sha256(r)>   — just-rotated refresh token, reusable
//                                          once within 60s (lost-response retry)
//   <key>:used                           — consume lock when GETDEL is unavailable
//
// Credentials (backend, upstash_url, upstash_token) are sealed with
// AES-256-GCM under LOGMEM_OAUTH_KEK into record.creds =
// {enc:"aes-256-gcm", iv, tag, ct}. Without a KEK, production refuses to
// mint (KekMissingError -> 503); other envs store {enc:"none", warning, data}.
//
// Token contents bind a backend AND a space: the MCP route restores the
// user's Redis creds and pins the connection to that one space.

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { restEndpoint } from "../../../src/lib/redis-rest.mjs";

const KEY = {
  client: (id) => `lm:oauth:client:${id}`,
  code: (h) => `lm:oauth:code:${h}`,
  token: (h) => `lm:oauth:token:${h}`,
  refresh: (h) => `lm:oauth:refresh:${h}`,
  refreshGrace: (h) => `lm:oauth:refresh-grace:${h}`,
  // TODO(remove after 2026-10-26): legacy raw-token key, see lookupAccessToken.
  legacyToken: (t) => `lm:oauth:token:${t}`,
};

export const TTL = {
  code: 600, // 10 min
  access: 60 * 60 * 12, // 12 hr — 1 hr caused re-auth churn when clients missed a refresh
  refresh: 60 * 60 * 24 * 30, // 30 d
  client: 60 * 60 * 24 * 30, // 30 d, refreshed on every getClient hit
  refreshGrace: 60, // previous refresh token reusable once within 60s
  lock: 30, // consume lock (fallback path only)
};

const DEPLOY_TIMEOUT_MS = 5000;
const AAD = Buffer.from("logmem-oauth-creds-v1");

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

// ───── Deploy Redis runner ─────

let testRunner = null;
/** Tests only: route all storage calls through `runner` (e.g. memory-redis). Pass null to reset. */
export function __setRedisForTests(runner) {
  testRunner = runner;
  getdelSupported = undefined;
}

function deployRedis() {
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

/** Seal the credential blob. Throws KekMissingError in production without a KEK. */
export function sealCreds(creds, env = process.env) {
  const kek = loadKek(env);
  if (!kek) {
    if (isProd(env)) throw new KekMissingError();
    return { enc: "none", warning: "LOGMEM_OAUTH_KEK unset: credentials stored unencrypted (non-production only)", data: creds };
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  return { enc: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** Inverse of sealCreds. Throws on a missing/wrong KEK or a tampered envelope. */
export function openCreds(envelope, env = process.env) {
  if (!envelope || typeof envelope !== "object") throw new Error("no credential envelope");
  if (envelope.enc === "none") {
    if (isProd(env)) throw new KekMissingError();
    return envelope.data;
  }
  if (envelope.enc !== "aes-256-gcm") throw new Error("unknown credential envelope");
  const kek = loadKek(env);
  if (!kek) throw new KekMissingError();
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(envelope.iv, "base64"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}

const CRED_FIELDS = new Set(["backend", "upstash_url", "upstash_token"]);

/** Move credential fields out of `rec` into a sealed `creds` envelope. */
function sealRecord(rec) {
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
 * upstash_token}). Legacy records (no `creds`) pass through unchanged.
 * Returns null if the envelope cannot be opened (rotated KEK, tampering).
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

const parse = (raw) => {
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
 * takes a SET NX lock on `<key>:used` so only one caller ever gets the value.
 */
async function consumeOnce(r, key) {
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
  const lock = await r("SET", `${key}:used`, "1", "NX", "EX", String(TTL.lock));
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
  const rec = parse(await r("GET", KEY.client(client_id)));
  if (rec) await r("EXPIRE", KEY.client(client_id), String(TTL.client)); // sliding 30d TTL
  return rec;
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
  return openRecord(parse(await consumeOnce(r, KEY.code(sha256hex(code)))));
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

  await r("SET", KEY.token(sha256hex(access)), JSON.stringify(accessRecord), "EX", String(TTL.access));
  await r("SET", KEY.refresh(sha256hex(refresh)), JSON.stringify(refreshRecord), "EX", String(TTL.refresh));

  return { access_token: access, token_type: "Bearer", expires_in: TTL.access, refresh_token: refresh, scope };
}

export async function lookupAccessToken(access_token) {
  if (!access_token || typeof access_token !== "string") return null;
  const r = deployRedis();
  const rec = parse(await r("GET", KEY.token(sha256hex(access_token))));
  if (rec) return openRecord(rec);
  // Backward compat: tokens minted before hashing were keyed by the raw value
  // (64 hex chars). They all expire within TTL.access (12h) of this deploy.
  // TODO(remove after 2026-10-26): drop this legacy raw-key lookup.
  if (/^[0-9a-f]{64}$/.test(access_token)) {
    return openRecord(parse(await r("GET", KEY.legacyToken(access_token))));
  }
  return null;
}

/**
 * Single-use refresh. The first consume moves the record to a 60s grace key;
 * one retry with the same token inside that window succeeds (covers a lost
 * token response), after which the token is dead.
 */
export async function consumeRefresh(refresh_token) {
  if (!refresh_token || typeof refresh_token !== "string") return null;
  const r = deployRedis();
  const h = sha256hex(refresh_token);
  const raw = await consumeOnce(r, KEY.refresh(h));
  if (raw) {
    await r("SET", KEY.refreshGrace(h), raw, "EX", String(TTL.refreshGrace));
    return openRecord(parse(raw));
  }
  return openRecord(parse(await consumeOnce(r, KEY.refreshGrace(h))));
}

export async function revokeAccessToken(access_token) {
  if (!access_token || typeof access_token !== "string") return;
  const r = deployRedis();
  await r("DEL", KEY.token(sha256hex(access_token)), KEY.legacyToken(access_token));
}
