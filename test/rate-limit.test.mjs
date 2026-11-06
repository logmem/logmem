import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUTE_CLASSES,
  DEFAULT_LIMITS,
  clientIp,
  rateLimitKey,
  localFallbackBucket,
  checkRateLimit,
  applyRateLimit,
} from "../src/http/rate-limit.mjs";

test("rate limit: clientIp extracts forwarded IP or falls back to remoteAddress", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" } }), "203.0.113.195");
  assert.equal(clientIp({ headers: { "x-real-ip": "198.51.100.42" } }), "198.51.100.42");
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientIp({}), "127.0.0.1");
});

test("rate limit: rateLimitKey separates authenticated and unauthenticated MCP keys", () => {
  const req = { headers: { "x-real-ip": "1.2.3.4" } };
  const unauthKey = rateLimitKey(req, ROUTE_CLASSES.MCP);
  assert.equal(unauthKey, "lm:rl:mcp:unauth:1.2.3.4");

  const authKey = rateLimitKey(req, ROUTE_CLASSES.MCP, { auth: { space: "team-prod", token: "secret" } });
  assert.match(authKey, /^lm:rl:mcp:auth:[0-9a-f]{24}$/);

  const authRouteKey = rateLimitKey(req, ROUTE_CLASSES.AUTH);
  assert.equal(authRouteKey, "lm:rl:auth:1.2.3.4");

  const readRouteKey = rateLimitKey(req, ROUTE_CLASSES.READ);
  assert.equal(readRouteKey, "lm:rl:read:1.2.3.4");
});

test("rate limit: in-memory fallback bucket enforces limits and calculates remaining/retryAfter", () => {
  localFallbackBucket.clear();
  const now = 1000000;
  const key = "test:memory:key";
  const limit = 3;
  const windowS = 60;

  // Hit 1
  let res = localFallbackBucket.check(key, limit, windowS, now);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 2);
  assert.equal(res.fallback, true);

  // Hit 2
  res = localFallbackBucket.check(key, limit, windowS, now + 1000);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 1);

  // Hit 3
  res = localFallbackBucket.check(key, limit, windowS, now + 2000);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 0);

  // Hit 4 (exceeded)
  res = localFallbackBucket.check(key, limit, windowS, now + 3000);
  assert.equal(res.ok, false);
  assert.equal(res.remaining, 0);
  assert.equal(res.retryAfter, 57);

  // After window resets
  res = localFallbackBucket.check(key, limit, windowS, now + 61000);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 2);
});

test("rate limit: checkRateLimit uses Redis and sets TTL", async () => {
  const store = new Map();
  const ttls = new Map();

  const mockRedis = async (cmd, key, val) => {
    if (cmd === "INCR") {
      const cur = (store.get(key) || 0) + 1;
      store.set(key, cur);
      return cur;
    }
    if (cmd === "EXPIRE") {
      ttls.set(key, Number(val));
      return 1;
    }
    if (cmd === "TTL") {
      return ttls.get(key) || -1;
    }
    throw new Error(`unknown cmd: ${cmd}`);
  };

  const res1 = await checkRateLimit(mockRedis, "test:redis:k1", 5, 60);
  assert.equal(res1.ok, true);
  assert.equal(res1.remaining, 4);
  assert.equal(res1.fallback, false);
  assert.equal(ttls.get("test:redis:k1"), 60);

  for (let i = 0; i < 4; i++) {
    await checkRateLimit(mockRedis, "test:redis:k1", 5, 60);
  }

  const resOver = await checkRateLimit(mockRedis, "test:redis:k1", 5, 60);
  assert.equal(resOver.ok, false);
  assert.equal(resOver.remaining, 0);
});

test("rate limit: checkRateLimit fails open to local bucket when Redis throws", async () => {
  localFallbackBucket.clear();
  const failingRedis = async () => {
    throw new Error("Redis connection refused");
  };

  const res = await checkRateLimit(failingRedis, "test:failopen:k1", 2, 60);
  assert.equal(res.ok, true);
  assert.equal(res.remaining, 1);
  assert.equal(res.fallback, true);
});

test("rate limit: applyRateLimit sets headers and sends 429 when exhausted", async () => {
  localFallbackBucket.clear();
  const headers = {};
  let statusCode = 200;
  let jsonBody = null;

  const mockReq = { headers: { "x-real-ip": "9.9.9.9" } };
  const mockRes = {
    setHeader(k, v) { headers[k] = v; },
    status(code) { statusCode = code; return this; },
    json(b) { jsonBody = b; return this; },
  };

  // Auth route limit is 20 req/min
  const passed = await applyRateLimit(mockReq, mockRes, {
    routeClass: ROUTE_CLASSES.AUTH,
    customLimit: { limit: 1, windowS: 60 },
  });
  assert.equal(passed, true);
  assert.equal(headers["X-RateLimit-Limit"], "1");
  assert.equal(headers["X-RateLimit-Remaining"], "0");

  const blocked = await applyRateLimit(mockReq, mockRes, {
    routeClass: ROUTE_CLASSES.AUTH,
    customLimit: { limit: 1, windowS: 60 },
  });
  assert.equal(blocked, false);
  assert.equal(statusCode, 429);
  assert.equal(headers["X-RateLimit-Remaining"], "0");
  assert.ok(headers["Retry-After"]);
  assert.equal(jsonBody.ok, false);
  assert.equal(jsonBody.error, "rate_limit_exceeded");
});
