// GET /api/health — liveness + backend reachability for uptime checks.
//
//   200 {"ok":true,"version":"0.1.0","commit":"abc1234","redis_ms":42,"region":"iad1"}
//   503 {"ok":false,...,"error":"backend unreachable"}
//
// One PING through descriptorFromEnv() with a 3 s budget. Never returns
// backend URLs, tokens or raw error text (which can carry hostnames).

import pkg from "../package.json" with { type: "json" };
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { logRequest } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 10 };

export const HEALTH_TIMEOUT_MS = 3000;

function ping(redis, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([Promise.resolve().then(() => redis("PING")), timeout]).finally(() => clearTimeout(timer));
}

/** Pure check: returns { status, body }. `resolve` is injectable for tests. */
export async function healthCheck({
  env = process.env,
  resolve = (e) => { const d = descriptorFromEnv(e); return d && fromDescriptor(d); },
  timeoutMs = HEALTH_TIMEOUT_MS,
  clock = () => performance.now(),
} = {}) {
  const base = {
    version: pkg.version,
    commit: String(env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    region: env.VERCEL_REGION || null,
  };
  let backend = null;
  try {
    backend = resolve(env);
  } catch {
    backend = null;
  }
  if (!backend) return { status: 503, body: { ok: false, ...base, redis_ms: null, error: "backend not configured" } };
  const t0 = clock();
  try {
    const pong = await ping(backend.redis, timeoutMs);
    const redis_ms = Math.round(clock() - t0);
    if (String(pong).toUpperCase() !== "PONG") {
      return { status: 503, body: { ok: false, ...base, redis_ms, error: "unexpected PING reply" } };
    }
    return { status: 200, body: { ok: true, ...base, redis_ms } };
  } catch (e) {
    const redis_ms = Math.round(clock() - t0);
    const error = e?.message === "timeout" ? `backend timed out after ${timeoutMs}ms` : "backend unreachable";
    return { status: 503, body: { ok: false, ...base, redis_ms, error } };
  }
}

export function createHandler(deps = {}) {
  return async function handler(req, res) {
    const t0 = performance.now();
    res.setHeader("Cache-Control", "no-store");
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.status(405).json({ ok: false, error: "method not allowed" });
      logRequest({ route: "/api/health", method: req.method, ms: performance.now() - t0, ok: false, status: 405 }, deps.log);
      return;
    }
    const { status, body } = await healthCheck(deps);
    res.status(status).json(body);
    logRequest({ route: "/api/health", method: req.method || "GET", ms: performance.now() - t0, ok: body.ok, status, err: body.error }, deps.log);
  };
}

export default createHandler();
