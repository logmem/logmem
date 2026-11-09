// src/http/rate-limit.mjs — general API rate limit middleware with route class limits.
//
// Route classes & limits (approved by Mikey, Nov 6 2026):
//   - MCP (mcp): 120 req/min for authenticated keys/spaces; 30 req/min unauthenticated
//   - AUTH (auth): 20 req/min per client IP (brute-force protection for login, session, oauth)
//   - READ (read): 300 req/min per client IP (public reads, health, view)
//   - CRON (cron): single execution lock + secret check
//
// Policy: Option A (Fail-open with local process bucket fallback).
// When Redis is unreachable or times out, the limiter falls back seamlessly to
// an in-memory token bucket per serverless process, ensuring zero downtime for
// legitimate traffic during transient Redis blips.

import { createHash } from "node:crypto";

export const ROUTE_CLASSES = {
  MCP: "mcp",
  AUTH: "auth",
  READ: "read",
  CRON: "cron",
};

export const DEFAULT_LIMITS = {
  [ROUTE_CLASSES.MCP]: { auth: 120, unauth: 30, windowS: 60 },
  [ROUTE_CLASSES.AUTH]: { limit: 20, windowS: 60 },
  [ROUTE_CLASSES.READ]: { limit: 300, windowS: 60 },
  [ROUTE_CLASSES.CRON]: { limit: 10, windowS: 60 },
};

export function clientIp(req) {
  const h = req?.headers || {};
  const xff = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = xff || String(h["x-real-ip"] || "").trim() || String(req?.socket?.remoteAddress || "");
  const ip = raw.toLowerCase().replace(/[^0-9a-f:.]/g, "").slice(0, 64);
  return ip || "127.0.0.1";
}

/** In-memory fallback bucket when Redis is unavailable. */
class MemoryBucket {
  constructor(maxEntries = 10000) {
    this.entries = new Map();
    this.maxEntries = maxEntries;
  }

  check(key, limit, windowS, now = Date.now()) {
    const windowMs = windowS * 1000;
    let rec = this.entries.get(key);
    if (!rec || now >= rec.resetAt) {
      if (this.entries.size >= this.maxEntries) {
        // Evict oldest entries
        const nowMs = Date.now();
        for (const [k, v] of this.entries.entries()) {
          if (nowMs >= v.resetAt) this.entries.delete(k);
        }
        if (this.entries.size >= this.maxEntries) {
          const firstKey = this.entries.keys().next().value;
          if (firstKey) this.entries.delete(firstKey);
        }
      }
      rec = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, rec);
    }
    rec.count += 1;
    const remaining = Math.max(0, limit - rec.count);
    const reset = Math.ceil(rec.resetAt / 1000);
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    return {
      ok: rec.count <= limit,
      limit,
      remaining,
      reset,
      retryAfter,
      fallback: true,
    };
  }

  clear() {
    this.entries.clear();
  }
}

export const localFallbackBucket = new MemoryBucket();

/** Derive rate-limit key for a request given its route class and auth context. */
export function rateLimitKey(req, routeClass, { auth = null, identifier = "" } = {}) {
  const ip = clientIp(req);
  if (routeClass === ROUTE_CLASSES.MCP) {
    if (auth && (auth.space || auth.token || auth.key || auth.sub)) {
      const id = String(auth.space || auth.key || auth.token || auth.sub || "");
      const hashed = createHash("sha256").update(id).digest("hex").slice(0, 24);
      return `lm:rl:mcp:auth:${hashed}`;
    }
    return `lm:rl:mcp:unauth:${ip}`;
  }
  if (identifier) {
    return `lm:rl:${routeClass}:${identifier}`;
  }
  return `lm:rl:${routeClass}:${ip}`;
}

/** Check rate limit using Redis with transparent fallback to MemoryBucket. */
export async function checkRateLimit(redis, key, limit, windowS, { now = Date.now() } = {}) {
  if (typeof redis !== "function") {
    return localFallbackBucket.check(key, limit, windowS, now);
  }
  try {
    const count = Number(await redis("INCR", key));
    if (count === 1) {
      await redis("EXPIRE", key, String(windowS));
    } else if (count > limit) {
      const ttl = Number(await redis("TTL", key).catch(() => windowS));
      if (ttl === -1) await redis("EXPIRE", key, String(windowS));
    }
    const ttl = Number(await redis("TTL", key).catch(() => windowS));
    const effectiveTtl = ttl > 0 ? ttl : windowS;
    const remaining = Math.max(0, limit - count);
    const reset = Math.floor(now / 1000) + effectiveTtl;
    return {
      ok: count <= limit,
      limit,
      remaining,
      reset,
      retryAfter: effectiveTtl,
      fallback: false,
    };
  } catch (err) {
    // Fail open with local in-memory fallback
    return localFallbackBucket.check(key, limit, windowS, now);
  }
}

/** Middleware helper: check limit, set headers, and respond 429 if exceeded. */
export async function applyRateLimit(req, res, {
  redis = null,
  routeClass = ROUTE_CLASSES.READ,
  auth = null,
  identifier = "",
  customLimit = null,
  now = Date.now(),
} = {}) {
  let limit;
  let windowS;
  if (customLimit) {
    limit = customLimit.limit;
    windowS = customLimit.windowS || 60;
  } else if (routeClass === ROUTE_CLASSES.MCP) {
    const isAuth = Boolean(auth && (auth.space || auth.token || auth.key || auth.sub));
    limit = isAuth ? DEFAULT_LIMITS.mcp.auth : DEFAULT_LIMITS.mcp.unauth;
    windowS = DEFAULT_LIMITS.mcp.windowS;
  } else {
    const conf = DEFAULT_LIMITS[routeClass] || DEFAULT_LIMITS[ROUTE_CLASSES.READ];
    limit = conf.limit;
    windowS = conf.windowS;
  }

  const key = rateLimitKey(req, routeClass, { auth, identifier });
  const result = await checkRateLimit(redis, key, limit, windowS, { now });

  if (res && typeof res.setHeader === "function") {
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(result.reset));
  }

  if (!result.ok && res) {
    if (typeof res.setHeader === "function") {
      res.setHeader("Retry-After", String(result.retryAfter));
    }
    if (typeof res.status === "function") {
      res.status(429).json({
        ok: false,
        error: "rate_limit_exceeded",
        message: `Too many requests on ${routeClass} route. Please retry after ${result.retryAfter} seconds.`,
        retry_after: result.retryAfter,
      });
    }
    return false;
  }

  return true;
}
