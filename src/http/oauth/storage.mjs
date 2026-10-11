// OAuth storage on Upstash Redis (deploy-owner instance).
//
// Keys (all under acmi:oauth: prefix, isolated from main ACMI bus):
//   acmi:oauth:client:<client_id>   — registered DCR client (no TTL)
//   acmi:oauth:code:<code>          — pending auth code (TTL 600s)
//   acmi:oauth:token:<access_token> — minted access token (TTL by exp)
//   acmi:oauth:refresh:<refresh>    — refresh token (TTL 30d)
//
// Token contents bind a tenant: { upstash_url, upstash_token } let the MCP
// route restore per-user Upstash creds without re-prompting.
//
// v0 stores creds plaintext (Upstash-hosted server, single-tenant trust). v1
// will wrap with AES-GCM via OAUTH_KEK env var.

import { randomBytes, createHash } from "node:crypto";
import { restEndpoint } from "../../_lib/redis.mjs";

const KEY = {
  client: (id) => `acmi:oauth:client:${id}`,
  code: (c) => `acmi:oauth:code:${c}`,
  token: (t) => `acmi:oauth:token:${t}`,
  refresh: (r) => `acmi:oauth:refresh:${r}`,
};

const TTL = {
  code: 600,        // 10 min
  access: 60 * 60 * 12, // 12 hr — 1 hr caused re-auth churn when clients missed a refresh
  refresh: 60 * 60 * 24 * 30, // 30 d
};

function deployRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("deploy missing UPSTASH_REDIS_REST_URL/_TOKEN");
  return async (...cmd) => {
    const res = await fetch(restEndpoint(url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const body = await res.json();
    if (body.error) throw new Error(`redis-rest ${body.error}`);
    return body.result;
  };
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

export function sha256base64url(input) {
  return createHash("sha256")
    .update(input)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ───── Clients ─────

export async function registerClient(meta) {
  const r = deployRedis();
  const client_id = `cli_${randomToken(8)}`;
  const client_secret = meta.token_endpoint_auth_method === "none" ? null : randomToken(24);
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
  await r("SET", KEY.client(client_id), JSON.stringify(record));
  return record;
}

export async function getClient(client_id) {
  if (!client_id) return null;
  const r = deployRedis();
  const raw = await r("GET", KEY.client(client_id));
  return raw ? JSON.parse(raw) : null;
}

// ───── Auth codes ─────

export async function saveAuthCode(payload) {
  const r = deployRedis();
  const code = randomToken(32);
  await r("SET", KEY.code(code), JSON.stringify(payload), "EX", String(TTL.code));
  return code;
}

export async function consumeAuthCode(code) {
  const r = deployRedis();
  const raw = await r("GET", KEY.code(code));
  if (!raw) return null;
  await r("DEL", KEY.code(code));
  return JSON.parse(raw);
}

// ───── Access + refresh tokens ─────

export async function mintTokens({ client_id, scope, upstash_url, upstash_token, backend, sub }) {
  const r = deployRedis();
  const access = randomToken(32);
  const refresh = randomToken(32);
  const issued_at = Math.floor(Date.now() / 1000);

  // `backend` is the generic credential blob ({kind:'upstash',url,token} or
  // {kind:'redis',uri}); upstash_url/_token stay populated for the upstash
  // kind so tokens minted here remain readable by pre-refactor code.
  const accessRecord = { client_id, scope, sub, upstash_url, upstash_token, backend, issued_at, expires_at: issued_at + TTL.access };
  const refreshRecord = { client_id, scope, sub, upstash_url, upstash_token, backend, issued_at };

  await r("SET", KEY.token(access), JSON.stringify(accessRecord), "EX", String(TTL.access));
  await r("SET", KEY.refresh(refresh), JSON.stringify(refreshRecord), "EX", String(TTL.refresh));

  return { access_token: access, token_type: "Bearer", expires_in: TTL.access, refresh_token: refresh, scope };
}

export async function lookupAccessToken(access_token) {
  if (!access_token) return null;
  const r = deployRedis();
  const raw = await r("GET", KEY.token(access_token));
  return raw ? JSON.parse(raw) : null;
}

export async function consumeRefresh(refresh_token) {
  const r = deployRedis();
  const raw = await r("GET", KEY.refresh(refresh_token));
  if (!raw) return null;
  await r("DEL", KEY.refresh(refresh_token));
  return JSON.parse(raw);
}

export async function revokeAccessToken(access_token) {
  const r = deployRedis();
  await r("DEL", KEY.token(access_token));
}
