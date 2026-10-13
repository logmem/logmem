// POST /api/onboarding/test — "Test connection" for the bring-your-own-Redis
// onboarding step.
//
//   {kind:"rest", url, token}   HTTP Redis REST (Upstash-style)
//   {kind:"redis", uri}         rediss:// over TCP
//   -> 200 {ok, reachable, results:[{cmd, ok}]}
//
// Same idea as scripts/bridge-probe.mjs, but strictly read-only: PING, then
// TYPE and EXISTS on a random key that does not exist (lm:probe:onboard:<hex>).
// Nothing is written to the user's Redis, and the credentials are used for
// these three commands only: never stored, never logged, never echoed.
//
// Abuse limits:
//   - SSRF guard (src/http/net-guard.mjs, the one OAuth uses): https:// or
//     rediss:// only, allowed ports only, every resolved address public
//   - the connection dials addresses[0] from that check (src/http/pin.mjs).
//     SNI and the HTTP Host stay on the original name. A later DNS answer
//     is never used. redis:// is refused here even if plaintext Redis is
//     allowed elsewhere.
//   - REST calls never follow redirects and time out after 5 s
//   - body at most 4 KB
//   - 10 requests per IP per minute (INCR + EXPIRE 60 on lm:onboard:rl:{ip},
//     on the deployment's own Redis)
//   - one generic message for every failure; upstream errors are not shown

import { randomBytes } from "node:crypto";
import { assertPublicTarget, isBlockedIp } from "../../src/http/net-guard.mjs";
import { restEndpoint } from "../../src/lib/redis-rest.mjs";
import { pinnedHttpsPost } from "../../src/http/pin.mjs";
import { serverRedis, readJsonBody, BodyError, noStore, methodNotAllowed, clientIp, rateLimit, UNAVAILABLE } from "../../src/http/onboarding.mjs";
import { logRequest, sendServerError } from "../../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 20 };

const ROUTE = "/api/onboarding/test";
export const MAX_BODY = 4096;
export const TIMEOUT_MS = 5000;
export const REFUSED = "That target isn't allowed. Use an https:// REST URL or a rediss:// URI on a public host.";
export const CONNECT_FAILED = "Could not connect with those credentials.";

/** The read-only command list, against a key that cannot exist. */
export function testCommands(key = `lm:probe:onboard:${randomBytes(12).toString("hex")}`) {
  return [["PING"], ["TYPE", key], ["EXISTS", key]];
}

/** One REST command: no redirects, bounded time, no error text kept. */
export function restRunner(url, token, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, pin, requestImpl } = {}) {
  const endpoint = restEndpoint(url);
  return async (...cmd) => {
    // A pin dials the checked address. Without one (tests that stub the
    // guard), fall back to the injected fetch, which never leaves the process.
    let r;
    if (pin) {
      try {
        r = await pinnedHttpsPost(endpoint, token, cmd, { pin, timeoutMs, requestImpl });
      } catch {
        throw new Error("not ok");
      }
    } else {
      r = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmd),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    if (!r.ok) throw new Error("not ok");
    const j = await r.json();
    if (!j || typeof j !== "object" || j.error) throw new Error("refused");
    return j.result;
  };
}

/** One native command on a throwaway pinned connection, closed afterwards. */
async function nativeRunnerFactory(uri, pin) {
  const { createPinnedRunner } = await import("../../src/lib/redis-native.mjs");
  return createPinnedRunner(uri, pin);
}

/**
 * Turn a guard result into a pin, or null when the guard is a test double
 * that only signals "allowed" by returning undefined. A real
 * assertPublicTarget result always carries addresses; anything else with a
 * non-public address or a plaintext scheme is refused.
 */
export function pinFromCheck(kind, target, checked) {
  if (checked === undefined) return null;
  const addresses = Array.isArray(checked?.addresses) ? checked.addresses : [];
  const protocol = checked?.protocol;
  const okProto = kind === "rest" ? protocol === "https:" : protocol === "rediss:";
  const hostname = String(checked?.hostname || "").replace(/^\[|\]$/g, "");
  if (!okProto || !hostname || !addresses.length || addresses.some((a) => isBlockedIp(a))) {
    const err = new Error("refused");
    err.code = "PIN_REFUSED";
    throw err;
  }
  if (kind === "redis" && !/^rediss:\/\//i.test(target)) {
    const err = new Error("refused");
    err.code = "PIN_REFUSED";
    throw err;
  }
  return { protocol, hostname, port: Number(checked.port), addresses: addresses.slice() };
}

/** Run the read-only commands. PING must answer PONG for the rest to count. */
export async function runTest(run) {
  const results = [];
  let reachable = false;
  for (const cmd of testCommands()) {
    let ok = false;
    try {
      const r = await run(...cmd);
      ok = cmd[0] === "PING" ? String(r).toUpperCase() === "PONG" : true;
    } catch {
      ok = false;
    }
    if (cmd[0] === "PING") {
      reachable = ok;
      results.push({ cmd: "PING", ok });
      if (!ok) break;
    } else results.push({ cmd: cmd[0], ok });
  }
  return { ok: reachable && results.length === 3 && results.every((r) => r.ok), reachable, results };
}

/** Validate the body into {kind, target, token?} or return an error string. */
export function parseTarget(body) {
  const kind = body.kind === "redis" ? "redis" : body.kind === "rest" ? "rest" : null;
  if (!kind) return { error: "kind must be rest or redis" };
  if (kind === "rest") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!url || !token || url.length > 512 || token.length > 2048) return { error: "REST URL and token are required" };
    return { kind, target: url, token };
  }
  const uri = typeof body.uri === "string" ? body.uri.trim() : "";
  if (!uri || uri.length > 1024) return { error: "Redis URI is required" };
  return { kind, target: uri };
}

export function createHandler({
  redis: getRedis = () => serverRedis(),
  guard = assertPublicTarget,
  fetchImpl = fetch,
  native = nativeRunnerFactory,
  requestImpl,
  log,
} = {}) {
  return async function handler(req, res) {
    const t0 = performance.now();
    noStore(res);
    const done = (status, body) => {
      res.status(status).json(body);
      logRequest({ route: ROUTE, method: req.method, ms: performance.now() - t0, ok: status < 400, status }, log ? { sink: log } : {});
    };
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const redis = getRedis();
    if (!redis) return done(503, { error: UNAVAILABLE });
    try {
      const rl = await rateLimit(redis, clientIp(req));
      if (!rl.ok) {
        res.setHeader("Retry-After", "60");
        return done(429, { error: "too many requests" });
      }
      let body;
      try {
        body = readJsonBody(req, MAX_BODY);
      } catch (e) {
        if (e instanceof BodyError) return done(e.status, { error: e.message });
        throw e;
      }
      const t = parseTarget(body);
      if (t.error) return done(400, { error: t.error });

      let pin = null;
      try {
        pin = pinFromCheck(t.kind, t.target, await guard(t.kind === "rest" ? restEndpoint(t.target) : t.target));
      } catch {
        return done(400, { error: REFUSED });
      }
      // Plaintext Redis is refused on this route even when the guard's env
      // opt-in would allow redis:// for other callers.
      if (t.kind === "redis" && !/^rediss:\/\//i.test(t.target)) return done(400, { error: REFUSED });

      let run;
      try {
        run = t.kind === "rest"
          ? restRunner(t.target, t.token, { fetchImpl, pin, requestImpl })
          : await native(t.target, pin);
      } catch {
        return done(200, { ok: false, reachable: false, results: [{ cmd: "PING", ok: false }], error: CONNECT_FAILED });
      }
      let out;
      try {
        out = await runTest(run);
      } finally {
        await run.close?.();
      }
      return done(200, out.reachable ? out : { ...out, error: CONNECT_FAILED });
    } catch (e) {
      sendServerError(res, ROUTE, e, log ? { sink: log } : {});
    }
  };
}

export default createHandler();
