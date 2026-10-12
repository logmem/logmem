// onboarding.mjs — shared pieces for the public /api/onboarding/* endpoints
// (probe pairing, connection test, hosted waitlist).
//
// These endpoints are unauthenticated, so every one of them:
//   - answers with Cache-Control: no-store
//   - bounds the request body before looking at it
//   - returns short generic errors (never backend detail, never input echo)
//   - stores under lm:onboard:* on the deployment's own backend
//     (descriptorFromEnv), and answers 503 when there is none.

import { fromDescriptor, descriptorFromEnv } from "../lib/backend.mjs";

export const KEYS = {
  probe: (code) => `lm:onboard:probe:${code}`,
  rate: (ip, bucket = "") => `lm:onboard:rl:${bucket ? `${bucket}:` : ""}${ip}`,
  waitlist: "lm:onboard:waitlist",
};

export const RATE_LIMIT = 10; // requests
export const RATE_WINDOW_S = 60; // per window

/** The deployment's own Redis runner, or null (callers answer 503). */
export function serverRedis(env = process.env) {
  try {
    const d = descriptorFromEnv(env);
    const b = d && fromDescriptor(d);
    return b ? b.redis : null;
  } catch {
    return null;
  }
}

/**
 * Client IP for rate limiting. On Vercel the platform sets x-forwarded-for
 * (first hop is the client) and x-real-ip; locally we fall back to the socket.
 * Reduced to [0-9a-f:.] so it is always a safe key segment.
 */
export function clientIp(req) {
  const h = req?.headers || {};
  const xff = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = xff || String(h["x-real-ip"] || "").trim() || String(req?.socket?.remoteAddress || "");
  const ip = raw.toLowerCase().replace(/[^0-9a-f:.]/g, "").slice(0, 64);
  return ip || "unknown";
}

/**
 * Fixed-window limiter: INCR, and EXPIRE 60 on the first hit of a window.
 * Returns { ok, count }. If the EXPIRE step ever failed the key would never
 * reset, so a count without a TTL gets its expiry re-applied.
 */
export async function rateLimit(redis, ip, { bucket = "", limit = RATE_LIMIT, windowS = RATE_WINDOW_S } = {}) {
  const key = KEYS.rate(ip, bucket);
  const count = Number(await redis("INCR", key));
  if (count === 1) await redis("EXPIRE", key, String(windowS));
  else if (count > limit) {
    const ttl = Number(await redis("TTL", key).catch(() => windowS));
    if (ttl === -1) await redis("EXPIRE", key, String(windowS));
  }
  return { ok: count <= limit, count };
}

export class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Parse a JSON object body of at most `maxBytes`. Vercel hands us req.body
 * already parsed for application/json (or a string / Buffer otherwise); the
 * Content-Length header is checked first so an oversize body is refused
 * without being measured.
 */
export function readJsonBody(req, maxBytes) {
  const declared = Number(req?.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyError(413, "body too large");
  let body = req?.body;
  let size;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    size = Buffer.byteLength(body, "utf8");
    if (size > maxBytes) throw new BodyError(413, "body too large");
    try {
      body = body ? JSON.parse(body) : null;
    } catch {
      throw new BodyError(400, "invalid JSON");
    }
  } else {
    let text;
    try {
      text = JSON.stringify(body ?? null);
    } catch {
      throw new BodyError(400, "invalid JSON");
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyError(413, "body too large");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new BodyError(400, "JSON object body required");
  return body;
}

export function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function methodNotAllowed(res, allow) {
  res.setHeader("Allow", allow);
  return res.status(405).json({ error: "method not allowed" });
}

export const UNAVAILABLE = "onboarding is not available on this deployment";
