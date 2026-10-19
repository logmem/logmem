// auth.mjs — resolve backend creds + space for an HTTP request.
//
// Order (first match wins):
//   1. Headers:  x-redis-uri  |  x-logmem-rest-url + x-logmem-rest-token
//                (legacy x-upstash-url/-token and x-acmi-bridge-url/-token accepted)
//   2. ?config=<base64 JSON> (Smithery): redisUri | restUrl+restToken (legacy names accepted)
//   3. OAuth 2.1 Bearer from /api/oauth/token  -> backend + space bound to the token
//   4. Agent key Bearer (lmk_...) -> server env backend, pinned to one space and one agent
//   5. Break-glass Bearer LOGMEM_DIRECT_AUTH_TOKEN -> server env backend
//
// Space: a token-bound space always wins and cannot be overridden. Otherwise
// x-logmem-space header, config.space, or LOGMEM_SPACE (default madez). The
// connection only ever sees that one space.
//
// SSRF: an OAuth token carries a caller-supplied backend that was checked at
// consent time, but DNS can change afterwards. Every OAuth resolution
// re-runs assertPublicTarget on that backend (cached ~60s per process) and
// treats a failure as unauthenticated. The deploy's own env backend is
// trusted and skipped. Follow-up: pin the resolved IP into the connection.

import { lookupAccessToken, safeEqual, sha256hex } from "../../api/oauth/_lib/storage.mjs";
import { descriptorFromEnv } from "../lib/backend.mjs";
import { assertPublicTarget } from "./net-guard.mjs";
import { lookupAgentKey, keySpaces, AGENT_KEY_PREFIX } from "./agent-keys.mjs";

const TARGET_CACHE_MS = 60_000;
const targetCache = new Map(); // sha256(target) -> { ok, until }

/** Tests only. */
export function __clearTargetCache() {
  targetCache.clear();
}

function isEnvBackend(b, env) {
  const d = descriptorFromEnv(env);
  if (!d) return false;
  if (b.kind === "redis") return d.kind === "redis" && d.uri === b.uri;
  return !d.kind && d.url === b.url;
}

/** true when the token's backend may be contacted. Never throws. */
export async function backendTargetAllowed(b, env = process.env, opts = {}) {
  if (isEnvBackend(b, env)) return true;
  const target = b.kind === "redis" ? b.uri : b.url;
  if (!target) return false;
  const k = sha256hex(target);
  const now = Date.now();
  const hit = targetCache.get(k);
  if (hit && hit.until > now) return hit.ok;
  let ok = true;
  try {
    await assertPublicTarget(target, { env, lookup: opts.lookup });
  } catch (e) {
    ok = false;
    console.warn(`[auth] oauth backend target refused: ${e?.reason || e?.name}`);
  }
  if (targetCache.size > 5000) targetCache.clear();
  targetCache.set(k, { ok, until: now + TARGET_CACHE_MS });
  return ok;
}

export function decodeConfig(req) {
  const url = new URL(req.url || "/api/mcp", "https://logmem.local");
  const b64 = url.searchParams.get("config");
  if (!b64) return {};
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new Error(`invalid base64 config: ${e.message}`);
  }
}

const h = (req, name) => req.headers[name] || null;

export function bearerOf(req) {
  const a = String(req.headers.authorization || req.headers.Authorization || "");
  return a.startsWith("Bearer ") ? a.slice(7).trim() : null;
}

export async function resolveAuth(req, cfg = {}, env = process.env, opts = {}) {
  const defaultSpace = h(req, "x-logmem-space") || cfg.space || cfg.LOGMEM_SPACE || cfg.acmiDefaultTenant || env.LOGMEM_SPACE || "madez";
  const out = (backend, source, extra = {}) => ({ backend, source, space: extra.space || defaultSpace, sub: extra.sub || null, pinned: !!extra.space, agent: extra.agent || null, keyId: extra.keyId || null });

  // Raw Redis creds in headers or ?config= turn a public deploy into an open
  // relay to any host. Production accepts only OAuth (and break-glass).
  const allowRaw = env.VERCEL_ENV !== "production" || env.LOGMEM_ALLOW_RAW_CREDS === "1";
  if (!allowRaw) return bearerAuth(req, env, out, defaultSpace, opts);
  const uri = h(req, "x-redis-uri");
  if (uri) return out({ kind: "redis", uri }, "header");
  const hu = h(req, "x-logmem-rest-url") || h(req, "x-acmi-bridge-url") || h(req, "x-upstash-url");
  const ht = h(req, "x-logmem-rest-token") || h(req, "x-acmi-bridge-token") || h(req, "x-upstash-token");
  if (hu && ht) return out({ url: hu, token: ht }, "header");

  const cu = cfg.redisUri || cfg.REDIS_URI;
  if (cu) return out({ kind: "redis", uri: cu }, "config");
  const curl = cfg.restUrl || cfg.acmiBridgeUrl || cfg.upstashRedisRestUrl || cfg.UPSTASH_REDIS_REST_URL;
  const ctok = cfg.restToken || cfg.acmiBridgeToken || cfg.upstashRedisRestToken || cfg.UPSTASH_REDIS_REST_TOKEN;
  if (curl && ctok) return out({ url: curl, token: ctok }, "config");

  return bearerAuth(req, env, out, defaultSpace, opts);
}

async function bearerAuth(req, env, out, defaultSpace, opts = {}) {
  const bearer = bearerOf(req);
  if (bearer) {
    try {
      const tok = await lookupAccessToken(bearer);
      if (tok && (tok.expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
        const b = tok.backend?.kind === "redis" ? { kind: "redis", uri: tok.backend.uri } : { url: tok.backend?.url || tok.upstash_url, token: tok.backend?.token || tok.upstash_token };
        if (await backendTargetAllowed(b, env, opts)) return out(b, "oauth", { sub: tok.sub, space: tok.space });
      }
    } catch {
      // fall through
    }
    if (bearer.startsWith(AGENT_KEY_PREFIX)) {
      try {
        const k = await (opts.lookupAgentKey || lookupAgentKey)(bearer);
        const d = k && keySpaces(env).includes(k.space) ? descriptorFromEnv(env) : null;
        if (d) return out(d, "agent-key", { space: k.space, sub: `agent:${k.agent}`, agent: k.agent, keyId: k.id });
      } catch {
        // fall through: an unreadable key store is unauthenticated, never open
      }
    }
    if (env.LOGMEM_DIRECT_AUTH_TOKEN && safeEqual(bearer, String(env.LOGMEM_DIRECT_AUTH_TOKEN))) {
      const d = descriptorFromEnv(env);
      if (d) return out(d, "env-authed");
    }
  }
  return { backend: null, source: "none", space: defaultSpace, sub: null, pinned: false };
}

export function wwwAuthenticate(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `Bearer realm="logmem", resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`;
}
