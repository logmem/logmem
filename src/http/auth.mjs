// auth.mjs — resolve backend creds + space for an HTTP request.
//
// Order (first match wins):
//   1. Headers:  x-redis-uri  |  x-logmem-rest-url + x-logmem-rest-token
//                (legacy x-upstash-url/-token and x-acmi-bridge-url/-token accepted)
//   2. ?config=<base64 JSON> (Smithery): redisUri | restUrl+restToken (legacy names accepted)
//   3. OAuth 2.1 Bearer from /api/oauth/token  -> backend + space bound to the token
//   4. Break-glass Bearer LOGMEM_DIRECT_AUTH_TOKEN -> server env backend
//
// Space: a token-bound space always wins and cannot be overridden. Otherwise
// x-logmem-space header, config.space, or LOGMEM_SPACE (default madez). The
// connection only ever sees that one space.

import { lookupAccessToken } from "../../api/oauth/_lib/storage.mjs";
import { descriptorFromEnv } from "../lib/backend.mjs";

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

export async function resolveAuth(req, cfg = {}, env = process.env) {
  const defaultSpace = h(req, "x-logmem-space") || cfg.space || cfg.LOGMEM_SPACE || cfg.acmiDefaultTenant || env.LOGMEM_SPACE || "madez";
  const out = (backend, source, extra = {}) => ({ backend, source, space: extra.space || defaultSpace, sub: extra.sub || null, pinned: !!extra.space });

  // Raw Redis creds in headers or ?config= turn a public deploy into an open
  // relay to any host. Production accepts only OAuth (and break-glass).
  const allowRaw = env.VERCEL_ENV !== "production" || env.LOGMEM_ALLOW_RAW_CREDS === "1";
  if (!allowRaw) return bearerAuth(req, env, out, defaultSpace);
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

  return bearerAuth(req, env, out, defaultSpace);
}

async function bearerAuth(req, env, out, defaultSpace) {
  const bearer = bearerOf(req);
  if (bearer) {
    try {
      const tok = await lookupAccessToken(bearer);
      if (tok && (tok.expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
        const b = tok.backend?.kind === "redis" ? { kind: "redis", uri: tok.backend.uri } : { url: tok.backend?.url || tok.upstash_url, token: tok.backend?.token || tok.upstash_token };
        return out(b, "oauth", { sub: tok.sub, space: tok.space });
      }
    } catch {
      // fall through
    }
    if (env.LOGMEM_DIRECT_AUTH_TOKEN && bearer === env.LOGMEM_DIRECT_AUTH_TOKEN) {
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
