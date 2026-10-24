import { lookupWorkspaceAgentKey } from './workspace-agent-keys.mjs';
import { authorizeSpace } from './workspaces.mjs';
import { customerRedis as workspaceRedis } from './jail.mjs';
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
// Audience: an OAuth token is bound to one resource (<issuer>/mcp). A token
// minted for another resource resolves as unauthenticated with
// error "invalid_token". Tokens minted before resource binding carry none and
// count as this server's. `scopes` is set for OAuth tokens only; other
// credentials are not limited by scope.
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
import { customerRedisUri } from "./jail.mjs";
import { canonicalResource, resourceMetadataUrl, scopesOf, ALL_SCOPES } from "./issuer.mjs";

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
  const out = (backend, source, extra = {}) => ({ backend, source, space: extra.space || defaultSpace, sub: extra.sub || null, pinned: !!extra.space, agent: extra.agent || null, keyId: extra.keyId || null, tenant: extra.tenant || null, ...(extra.workspaceId ? { workspaceId:extra.workspaceId, spaceId:extra.spaceId, issuedBy:extra.issuedBy, connectionId:extra.connectionId } : {}), ...(extra.scopes ? { scopes: extra.scopes } : {}) });

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
    if (bearer.startsWith('lmw_')) {
      try {
        const k = await (opts.lookupWorkspaceAgentKey || lookupWorkspaceAgentKey)(bearer);
        if (!k) return out(null, 'none');
        const uri = customerRedisUri(env);
        return out({ kind:'redis', uri }, 'managed', { ...k, keyId:k.id, connectionId:k.id, sub:`agent:${k.agent}` });
      } catch { return out(null, 'none'); }
    }
    try {
      const tok = await lookupAccessToken(bearer);
      if (tok && (tok.expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
        if (tok.resource && tok.resource !== canonicalResource(req, env)) {
          return { backend: null, source: "none", space: defaultSpace, sub: null, pinned: false, error: "invalid_token" };
        }
        const scopes = scopesOf(tok.scope);
        // Managed account (one-click connect): the server's customer Redis, jailed
        // to the token's space and locked to its agent by the MCP route.
        if (tok.backend?.kind === "managed") {
          let uri = null;
          try {
            uri = customerRedisUri(env);
          } catch {
            // not configured: unauthenticated, never another backend
          }
          if (!uri || !tok.backend.tenant || !tok.backend.agent || !tok.space) return { backend: null, source: "none", space: defaultSpace, sub: null, pinned: false };
          if (tok.backend.workspaceId) {
            const g = tok.backend;
            const context = await authorizeSpace({ userId:g.issuedBy, workspaceId:g.workspaceId, spaceId:g.spaceId, action:'manage-connections' }, { redis: opts.workspaceRedis || workspaceRedis(env) });
            if (context.space.namespace !== tok.space || context.workspace.tenantId !== g.tenant) return out(null, 'none');
          }
          return out({ kind: "redis", uri }, "managed", { ...tok.backend, space: tok.space, sub: tok.sub, agent: tok.backend.agent, tenant: tok.backend.tenant, keyId: `mf_${tok.fid || "x"}`, scopes });
        }
        // Fleet sign-in (an admin picked a deploy space on the consent page): the
        // deploy's own backend, pinned to the token's space and locked to its
        // agent, exactly like an agent key. The token holds no backend creds.
        if (tok.backend?.kind === "fleet") {
          const d = tok.backend.agent && tok.space && keySpaces(env).includes(tok.space) ? descriptorFromEnv(env) : null;
          if (!d) return { backend: null, source: "none", space: defaultSpace, sub: null, pinned: false };
          return out(d, "fleet-oauth", { space: tok.space, sub: tok.sub, agent: tok.backend.agent, keyId: `ff_${tok.fid || "x"}`, scopes });
        }
        const b = tok.backend?.kind === "redis" ? { kind: "redis", uri: tok.backend.uri } : { url: tok.backend?.url || tok.upstash_url, token: tok.backend?.token || tok.upstash_token };
        if (await backendTargetAllowed(b, env, opts)) return out(b, "oauth", { sub: tok.sub, space: tok.space, scopes });
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

/**
 * The 401/403 challenge (RFC 6750, RFC 9728). resource_metadata and scope let
 * a client find the authorization server and ask for the right scopes;
 * error names why a presented token failed.
 */
export function wwwAuthenticate(req, { error, scope = ALL_SCOPES } = {}, env = process.env) {
  let metadata;
  try {
    metadata = resourceMetadataUrl(req, env);
  } catch {
    metadata = resourceMetadataUrl(req, {}); // misconfigured LOGMEM_ISSUER: the metadata route reports it
  }
  const parts = [`Bearer realm="logmem"`, `resource_metadata="${metadata}"`, `scope="${scope}"`];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

