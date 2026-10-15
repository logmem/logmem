// onboarding.mjs — shared pieces for the public /api/onboarding/* endpoints
// (probe pairing, connection test, hosted waitlist).
//
// These endpoints are unauthenticated, so every one of them:
//   - answers with Cache-Control: no-store
//   - bounds the request body before looking at it
//   - returns short generic errors (never backend detail, never input echo)
//   - stores under lm:onboard:* on the deployment's own backend
//     (descriptorFromEnv), and answers 503 when there is none.

import { randomBytes } from "node:crypto";
import { fromDescriptor, descriptorFromEnv } from "../lib/backend.mjs";

export const KEYS = {
  probe: (code) => `lm:onboard:probe:${code}`,
  // ZSET of live pairing codes. Score is the unix expiry second.
  probeLive: "lm:onboard:probe:live",
  // Serializes the probe cap. Value is a random holder token, never a code.
  probeLock: "lm:onboard:lock:probe",
  rate: (ip, bucket = "") => `lm:onboard:rl:${bucket ? `${bucket}:` : ""}${ip}`,
  // One string per signup, with no expiry. The index score is the unix
  // second of the first signup. The member is sha256(normalized email).
  // Rows from before 2026-10-15 carry an expiry second as their score.
  waitlistEntry: (field) => `lm:onboard:waitlist:${field}`,
  waitlistIndex: "lm:onboard:waitlist:index",
  // Stream with one entry per signup, repeats too. Never trimmed.
  waitlistLog: "lm:onboard:waitlist:log",
  // Was the waitlist cap lock. Nothing takes it now. A stale holder expires by EX.
  waitlistLock: "lm:onboard:lock:waitlist",
};

/**
 * Drop index members whose score is <= nowSec (already expired) and return
 * how many remain. Members come back so the caller can delete the payload
 * keys; the index itself holds only ids, not emails or probe bodies.
 */
export async function sweepIndex(redis, indexKey, nowSec) {
  const raw = await redis("ZRANGEBYSCORE", indexKey, "-inf", String(nowSec));
  const members = Array.isArray(raw) ? raw.filter((m) => m != null && m !== "").map(String) : [];
  for (let i = 0; i < members.length; i += 200) {
    await redis("ZREM", indexKey, ...members.slice(i, i + 200));
  }
  return { expired: members, live: Number(await redis("ZCARD", indexKey)) || 0 };
}

export const RATE_LIMIT = 10; // requests
export const RATE_WINDOW_S = 60; // per window
/** The waitlist has no lock or cap, so it allows more per IP than the default. */
export const WAITLIST_RATE_LIMIT = 30;

/**
 * Client-facing 429 for a busy cap lock. Kept apart from the per-IP limiter's
 * "too many requests" so the two failures are not the same signal.
 */
export const LOCK_BUSY_ERROR = "store busy";
export const LOCK_RETRY_AFTER_S = 1;

/**
 * Vercel maxDuration on /api/onboarding/probe and /api/onboarding/waitlist.
 * An isolate can still be inside the locked section until that budget ends,
 * so the lock TTL has to be longer than this whole window, not just the work
 * that happens to have run so far.
 */
export const ROUTE_MAX_DURATION_S = 10;
export const LOCK_TTL_S = 30;
/** Waiters give up well under the route budget and the handler answers 429. */
export const LOCK_WAIT_MS = 2000;

/** Thrown when a capped write could not take the store lock before its budget ran out. */
export class StoreLockError extends Error {
  constructor() {
    super(LOCK_BUSY_ERROR);
    this.name = "StoreLockError";
    this.code = "LOCK_BUSY";
    this.retryAfter = LOCK_RETRY_AFTER_S;
  }
}

/**
 * Exponential backoff with equal jitter. The floor is half the ceiling, so a
 * waiter cannot tight-spin SET NX the way a zero-delay pause does.
 */
function lockBackoffMs(attempt) {
  const ceiling = Math.min(120, 20 * 2 ** attempt);
  const half = ceiling / 2;
  return Math.floor(half + Math.random() * half);
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * Run `fn` while this caller is the only holder of `key` on the shared store.
 *
 * The probe cap is a read of the live count followed by a write. Each of
 * those commands is atomic, and the gap between them is not: overlapping
 * requests can all observe "under the cap" and all insert.
 * SET key token NX EX is one atomic command on every backend this runner
 * talks to (REST, TCP, and the in-memory double). The admit (count, then
 * insert) runs only while holding that key. `fn` receives `{ requireHeld }`,
 * which re-reads the token and throws StoreLockError when this caller is no
 * longer the holder. Call it immediately before the insert.
 *
 * Release is not an EVAL compare-and-delete. src/lib/redis-native.mjs rejects
 * EVAL (`translate` throws "unsupported command"; there is no EVAL case), and
 * src/lib/memory-redis.mjs does the same. src/lib/redis-rest.mjs would forward
 * the script, but descriptorFromEnv picks TCP or REST per deployment, and the
 * in-memory double is what tests and local dev run. One release path has to
 * be commands all three implement, which is GET then DEL, and only DEL when
 * the value is still this token. That pair is racy if EX fires between the
 * two commands and a new holder has taken the key. LOCK_TTL_S stays above
 * ROUTE_MAX_DURATION_S so a live isolate is not still inside `fn` after EX,
 * and requireHeld refuses the insert when the token has already changed.
 * EX still drops the key if this process dies without reaching release.
 *
 * Acquire and release share one try/finally. If SET throws, the write may
 * already be stored under this token; the finally block deletes the key when
 * GET still returns it, then the SET error propagates.
 *
 * A busy key is retried with backoff until `waitMs` (LOCK_WAIT_MS, about 2s).
 * Past that, StoreLockError asks the route for 429 with Retry-After.
 */
export async function withStoreLock(redis, key, fn, { ttlS = LOCK_TTL_S, waitMs = LOCK_WAIT_MS } = {}) {
  const ttl = Number(ttlS);
  if (!(ttl > ROUTE_MAX_DURATION_S)) throw new Error("lock TTL must outlive the route");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + Number(waitMs);
  let held = false;
  let setMayHaveLanded = false;
  const release = async () => {
    try {
      const cur = await redis("GET", key);
      if (cur === token) await redis("DEL", key);
    } catch {
      // EX drops the key if this process never comes back.
    }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const ok = await redis("SET", key, token, "NX", "EX", String(ttl));
        if (ok === "OK") {
          held = true;
          break;
        }
      } catch (e) {
        setMayHaveLanded = true;
        throw e;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(lockBackoffMs(attempt), remaining));
    }
    if (!held) throw new StoreLockError();
    return await fn({
      async requireHeld() {
        const cur = await redis("GET", key);
        if (cur !== token) throw new StoreLockError();
      },
    });
  } finally {
    if (held || setMayHaveLanded) await release();
  }
}

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
