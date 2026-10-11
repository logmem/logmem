// Upstash REST client + multi-instance credential resolution.
// Server-side only. Never imported into client bundle.
//
// Multi-tenant model:
//   - default instance from UPSTASH_REDIS_REST_URL / _TOKEN
//   - additional instances via per-id env vars (URL_<ID> / TOKEN_<ID>),
//     where <ID> is uppercased and dashes→underscores (e.g. mz-prod → MZ_PROD)
//   - selection via cookie `acmi-instance=<id>` or query ?instance=<id>
//
// Read-only: api/* never writes to ACMI. All endpoints are GET-only.

export function resolveInstance(req) {
  const url = new URL(req.url);
  const queryId = url.searchParams.get("instance");
  const cookieHeader = req.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/acmi-instance=([^;]+)/);
  const cookieId = cookieMatch?.[1];
  const id = (queryId || cookieId || "default").trim();

  if (id === "default") {
    return {
      id: "default",
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    };
  }

  const slug = id.toUpperCase().replace(/-/g, "_");
  return {
    id,
    url: process.env[`UPSTASH_URL_${slug}`] || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env[`UPSTASH_TOKEN_${slug}`] || process.env.UPSTASH_REDIS_REST_TOKEN || "",
  };
}

/** Polar HTTPS exec is `/bridge/exec` with no trailing slash (slash → 404). */
export function isBridgeUrl(url) {
  return /\/bridge\/exec(?:\/|$|\?)/.test(String(url || ""));
}

/**
 * POST target for HTTP Redis REST.
 * Polar exec: strip slashes. Upstash Cloud: keep a trailing slash.
 * Everything else: strip (Polar-safe default).
 */
export function restEndpoint(url) {
  const stripped = String(url || "").replace(/\/+$/, "");
  if (!stripped) return stripped;
  if (isBridgeUrl(stripped)) return stripped;
  try {
    if (new URL(stripped).hostname.endsWith("upstash.io")) return `${stripped}/`;
  } catch {
    /* ignore invalid URL; caller will fail the fetch */
  }
  return stripped;
}

export async function redis(instance, ...cmd) {
  if (!instance.url || !instance.token) {
    throw new Error(`No credentials for instance "${instance.id}"`);
  }
  const endpoint = restEndpoint(instance.url);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${instance.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Redis REST ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Redis REST: ${data.error}`);
  return data.result;
}

/**
 * Factory for arbitrary-tenant Upstash clients. Used by the HTTP MCP route
 * (api/mcp.mjs) which receives Upstash creds per-request via Smithery's
 * base64 config rather than from server-side env vars.
 *
 * This file is imported by Edge Functions, so it must stay free of Node-only
 * modules — the self-hosted-Redis backend lives in redis-native.mjs and is
 * wired up only from Node-runtime routes (api/mcp.mjs, oauth/authorize.mjs).
 *
 * Pattern: const r = createRedis({url, token}); await r('GET', 'acmi:agent:foo:profile')
 *
 * NEVER pass process.env.UPSTASH_REDIS_REST_URL into this — that would leak
 * the Mikey-tenant to Smithery-hosted clients. The MCP route is for
 * customer-supplied tenant creds only.
 */
export function createRedis({ url, token }) {
  if (!url || !token) {
    throw new Error("createRedis: url and token required");
  }
  const endpoint = restEndpoint(url);
  return async function redisCall(...cmd) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmd),
    });
    if (!res.ok) throw new Error(`Redis REST ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`Redis REST: ${data.error}`);
    return data.result;
  };
}

// Try to JSON.parse a string; return original on failure.
export function tryParse(s) {
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return s; }
}

// Common JSON response with cache + CORS headers.
export function json(data, { sMaxage = 5, status = 200 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${sMaxage}, stale-while-revalidate=30`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function err(message, status = 500) {
  return json({ error: message, ts: Date.now() }, { sMaxage: 0, status });
}
