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

// ---- timeouts + retry -------------------------------------------------------
//
// Every REST call is bounded by LOGMEM_REDIS_TIMEOUT_MS (default 5000) per
// attempt. Read-only commands get exactly one retry after 200-400 ms of jitter
// when the failure is transient (timeout, network error, 429, 5xx). Writes are
// never retried: a write that timed out may still have landed, and replaying
// LPUSH/ZADD/INCR would duplicate it.
//
// Error messages name the command and the failure class only. They never carry
// the endpoint URL or the token (both are secrets on this deployment).

export const READ_COMMANDS = new Set([
  "GET", "HGET", "HGETALL", "SMEMBERS", "LRANGE", "ZRANGE", "ZREVRANGE",
  "ZRANGEBYSCORE", "ZCARD", "ZSCORE", "HMGET", "LLEN", "TYPE", "EXISTS", "SCAN",
  "PING", "TTL", "DBSIZE",
]);

export const DEFAULT_REDIS_TIMEOUT_MS = 5000;

export function redisTimeoutMs(env = process.env) {
  const n = Number(env?.LOGMEM_REDIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REDIS_TIMEOUT_MS;
}

export function isReadCommand(cmd) {
  return READ_COMMANDS.has(String(cmd ?? "").toUpperCase());
}

/** Low-level socket error code (ECONNREFUSED, ENOTFOUND, ...) only; never the message, which can carry the host. */
function causeCode(e) {
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 200 + Math.floor(Math.random() * 201);

class RedisRestError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = "RedisRestError";
    this.transient = transient;
  }
}

async function restAttempt(endpoint, token, cmd, name, timeoutMs) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cmd),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new RedisRestError(
      timedOut
        ? `Redis REST ${name}: timed out after ${timeoutMs}ms`
        : `Redis REST ${name}: network error${causeCode(e) ? ` (${causeCode(e)})` : ""}`,
      { transient: true },
    );
  }
  if (!res.ok) {
    throw new RedisRestError(`Redis REST ${name}: HTTP ${res.status}`, {
      transient: res.status === 429 || res.status >= 500,
    });
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    throw new RedisRestError(
      timedOut ? `Redis REST ${name}: timed out after ${timeoutMs}ms` : `Redis REST ${name}: bad response body`,
      { transient: timedOut },
    );
  }
  if (data?.error) throw new RedisRestError(`Redis REST ${name}: ${data.error}`);
  return data?.result;
}

/** One REST command with timeout, plus one jittered retry for transient read failures. */
export async function restCommand(endpoint, token, cmd, { timeoutMs = redisTimeoutMs() } = {}) {
  const name = String(cmd?.[0] ?? "?").toUpperCase();
  try {
    return await restAttempt(endpoint, token, cmd, name, timeoutMs);
  } catch (e) {
    if (!(e instanceof RedisRestError) || !e.transient || !READ_COMMANDS.has(name)) throw e;
    await sleep(jitter());
    return await restAttempt(endpoint, token, cmd, name, timeoutMs);
  }
}

export async function redis(instance, ...cmd) {
  if (!instance.url || !instance.token) {
    throw new Error(`No credentials for instance "${instance.id}"`);
  }
  return restCommand(restEndpoint(instance.url), instance.token, cmd);
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
    return restCommand(endpoint, token, cmd);
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
