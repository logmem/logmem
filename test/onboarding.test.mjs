// /api/onboarding/* — probe pairing, hosted waitlist, connection test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { oauthRedis, mockRes, mockReq, withEnv } from "./oauth-helpers.mjs";
import { createHandler as probeHandler, cleanAgents, TTL_S, PROBE_POST_LIMIT, PROBE_GET_LIMIT, config as probeConfig } from "../api/onboarding/probe.mjs";
import { createHandler as waitlistHandler, normalizeEmail, emailKey, WAITLIST_TTL_S, config as waitlistConfig } from "../api/onboarding/waitlist.mjs";
import { createHandler as testHandler, runTest, REFUSED, CONNECT_FAILED } from "../api/onboarding/test.mjs";
import { clientIp, rateLimit, readJsonBody, KEYS, withStoreLock, StoreLockError, LOCK_BUSY_ERROR, LOCK_TTL_S, LOCK_WAIT_MS, ROUTE_MAX_DURATION_S } from "../src/http/onboarding.mjs";
import { assertPublicTarget } from "../src/http/net-guard.mjs";
import { pinLookup, pinnedHttpsOptions, pinnedHttpsPost, pinnedNativeOptions, PinError } from "../src/http/pin.mjs";

const quiet = () => {};
const call = async (handler, opts) => {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, raw: res.body, headers: res.headers };
};
const get = (handler, code) => call(handler, { method: "GET", url: `/api/onboarding/probe?code=${code}` }).then((r) => r);

function probeWith(redis, opts = {}) {
  const h = probeHandler({ redis: () => redis, log: quiet, ...opts });
  return async (req, res) => {
    // Vercel fills req.query from the URL.
    req.query = Object.fromEntries(new URL(req.url, "http://x").searchParams);
    return h(req, res);
  };
}

// ---- probe -------------------------------------------------------------------

test("probe: rejects bad codes on POST and GET", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  for (const code of ["abc123", "ABC12", "ABC1234", "ABC-12", "", 123456, null]) {
    const r = await call(h, { method: "POST", body: { code, agents: [] } });
    assert.equal(r.status, 400, `code ${JSON.stringify(code)}`);
  }
  assert.equal((await call(h, { method: "GET", url: "/?code=abc123" })).status, 400);
  assert.equal((await call(h, { method: "GET", url: "/?code=" })).status, 400);
  assert.deepEqual([...redis.data.keys()].filter((k) => !k.startsWith("lm:onboard:rl:")), [], "nothing stored but the rate-limit counter");
});

test("probe: body over 2 KB is refused before anything is stored", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  const big = { code: "ABC123", agents: [{ name: "claude", version: "x".repeat(3000) }] };
  assert.equal((await call(h, { method: "POST", body: big })).status, 413);
  assert.equal((await call(h, { method: "POST", body: JSON.stringify(big) })).status, 413, "raw string body");
  assert.equal((await call(h, { method: "POST", body: { code: "ABC123", agents: [] }, headers: { "content-length": "4096" } })).status, 413, "declared length");
  assert.deepEqual([...redis.data.keys()].filter((k) => k.startsWith("lm:onboard:probe:")), [], "the payload was not stored");
});

test("probe: unknown names dropped, duplicates collapsed, versions cleaned, nothing else stored", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  const r = await call(h, {
    method: "POST",
    body: {
      code: "ABC123",
      env: { HOME: "/Users/me", OPENAI_API_KEY: "sk-secret" },
      agents: [
        { name: "claude", version: "2.1.0 (Claude Code)" },
        { name: "CLAUDE", version: "dup" },
        { name: "evil", version: "1" },
        { name: "codex", version: "v".repeat(41) },
        { name: "gemini", version: "0.46\u0000\n" },
        { name: "goose", version: 12 },
        "cursor",
        { name: "aider" },
      ],
    },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true }, "nothing echoed");
  const stored = JSON.parse(redis.data.get(KEYS.probe("ABC123")).value);
  assert.deepEqual(stored.agents, [
    { name: "claude", version: "2.1.0 (Claude Code)" },
    { name: "codex", version: "" },
    { name: "gemini", version: "" },
    { name: "goose", version: "" },
    { name: "aider", version: "" },
  ]);
  assert.deepEqual(Object.keys(stored).sort(), ["agents", "ts"]);
  assert.ok(!redis.data.get(KEYS.probe("ABC123")).value.includes("sk-secret"));
  const g = await call(h, { method: "GET", url: "/?code=ABC123" });
  assert.equal(g.status, 200);
  assert.deepEqual(g.body, { agents: stored.agents });
  assert.equal(g.headers["cache-control"], "no-store");
});

test("probe: write-once with a 10-minute TTL", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  const first = await call(h, { method: "POST", body: { code: "ZZ9ZZ9", agents: [{ name: "codex", version: "1" }] } });
  assert.equal(first.status, 201);
  const second = await call(h, { method: "POST", body: { code: "ZZ9ZZ9", agents: [{ name: "claude", version: "2" }] } });
  assert.equal(second.status, 409);
  const set = redis.calls.find((c) => c[0] === "SET" && c[1] === KEYS.probe("ZZ9ZZ9"));
  assert.deepEqual(set.slice(3), ["NX", "EX", "600"]);
  assert.equal(TTL_S, 600);
  assert.equal(redis.ttls.get(KEYS.probe("ZZ9ZZ9")), 600);
  assert.equal((await call(h, { method: "GET", url: "/?code=ZZ9ZZ9" })).body.agents[0].name, "codex", "first write kept");
  assert.equal((await call(h, { method: "GET", url: "/?code=QQQQQQ" })).status, 404);
});

test("probe: methods, no backend, and cleanAgents edge cases", async () => {
  const h = probeWith(oauthRedis());
  assert.equal((await call(h, { method: "PUT", body: {} })).status, 405);
  assert.equal((await call(h, { method: "POST", body: [] })).status, 400, "array body");
  const none = probeHandler({ redis: () => null, log: quiet });
  const r = await call(none, { method: "POST", body: { code: "ABC123", agents: [] } });
  assert.equal(r.status, 503);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.deepEqual(cleanAgents("claude"), []);
  assert.equal(cleanAgents(Array.from({ length: 100 }, () => ({ name: "claude", version: "1" }))).length, 1);
});

test("probe: 10 POSTs and 40 GETs per IP per minute, buckets are separate", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  const post = (code, ip) => call(h, { method: "POST", body: { code, agents: [] }, headers: { "x-forwarded-for": ip } });
  for (let i = 0; i < PROBE_POST_LIMIT; i++) {
    assert.equal((await post(`AAA00${i}`, "203.0.113.77")).status, 201);
  }
  const blocked = await post("AAA099", "203.0.113.77");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["retry-after"], "60");
  assert.equal(blocked.body.error, "too many requests");
  assert.equal(redis.data.has(KEYS.probe("AAA099")), false, "the refused POST stored nothing");
  assert.equal(redis.ttls.get("lm:onboard:rl:probe-post:203.0.113.77"), 60);
  assert.equal((await post("AAA098", "198.51.100.77")).status, 201, "other IPs have their own window");
  for (let i = 0; i < PROBE_GET_LIMIT; i++) {
    assert.equal((await call(h, { method: "GET", url: "/?code=AAA000", headers: { "x-forwarded-for": "203.0.113.77" } })).status, 200);
  }
  const getBlocked = await call(h, { method: "GET", url: "/?code=AAA000", headers: { "x-forwarded-for": "203.0.113.77" } });
  assert.equal(getBlocked.status, 429);
  assert.equal(getBlocked.headers["retry-after"], "60");
});

test("probe: global cap on live keys, freed when they expire", async () => {
  const redis = oauthRedis();
  let now = 1_700_000_000_000;
  const h = probeWith(redis, { now: () => now, liveCap: 2 });
  const post = (code) => call(h, { method: "POST", body: { code, agents: [{ name: "claude", version: "1" }] }, headers: { "x-forwarded-for": "203.0.113.78" } });
  assert.equal((await post("CAP001")).status, 201);
  assert.equal((await post("CAP002")).status, 201);
  const full = await post("CAP003");
  assert.equal(full.status, 429);
  assert.equal(full.body.error, "probe capacity reached");
  assert.equal(full.headers["retry-after"], "600");
  assert.equal(redis.data.has(KEYS.probe("CAP003")), false);
  assert.equal((await post("CAP001")).status, 409, "a live code is still write-once, not a capacity error");
  assert.equal(redis.data.get(KEYS.probeLive).value.size, 2);

  now += TTL_S * 1000;
  assert.equal((await call(h, { method: "GET", url: "/?code=CAP001", headers: { "x-forwarded-for": "203.0.113.79" } })).status, 404);
  assert.equal(redis.data.has(KEYS.probe("CAP001")), false, "expired pairing key deleted");
  assert.equal(redis.data.has(KEYS.probe("CAP002")), false);
  assert.equal((await post("CAP003")).status, 201, "a slot freed by expiry can be used");
  assert.equal(redis.data.get(KEYS.probeLive).value.size, 1);
});

// Count the capped keys after every Redis command. A check-then-act cap goes
// over the limit at a yield point, which is the moment another request can run.
function observe(redis, measure) {
  let high = 0;
  const wrapped = async (cmd, ...args) => {
    const result = await redis(cmd, ...args);
    high = Math.max(high, measure());
    return result;
  };
  wrapped.data = redis.data;
  wrapped.ttls = redis.ttls;
  wrapped.calls = redis.calls;
  wrapped.high = () => high;
  return wrapped;
}

const probeCode = (i) => `A${i.toString(36).toUpperCase().padStart(5, "0")}`;

test("probe: a parallel burst never stores more than the live cap", async () => {
  const raw = oauthRedis();
  const stored = () => {
    const payloads = [...raw.data.keys()].filter((k) => /^lm:onboard:probe:[A-Z0-9]{6}$/.test(k)).length;
    const index = raw.data.get(KEYS.probeLive)?.value.size ?? 0;
    return Math.max(payloads, index);
  };
  const redis = observe(raw, stored);
  const cap = 5;
  const h = probeWith(redis, { liveCap: cap });
  const n = 30;
  // One address each, so the per-IP limit of 10 does not stop the burst.
  const results = await Promise.all(Array.from({ length: n }, (_, i) => call(h, {
    method: "POST",
    body: { code: probeCode(i), agents: [{ name: "claude", version: "1" }] },
    headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
  })));
  assert.equal(stored(), cap, "final payload and index count sit on the cap");
  assert.ok(redis.high() <= cap, `high-water ${redis.high()} exceeded cap ${cap}`);
  assert.equal(results.filter((r) => r.status === 201).length, cap);
  const blocked = results.filter((r) => r.status === 429);
  assert.equal(blocked.length, n - cap);
  assert.ok(blocked.every((r) => r.body.error === "probe capacity reached" && r.headers["retry-after"] === "600"));
  assert.equal(raw.data.has(KEYS.probeLock), false, "the lock is released");
  const again = await call(h, {
    method: "POST",
    body: { code: probeCode(0), agents: [{ name: "codex", version: "2" }] },
    headers: { "x-forwarded-for": "203.0.113.200" },
  });
  assert.equal(again.status === 409 || again.status === 429, true);
  assert.equal(stored(), cap, "a follow-up does not open another slot");
});

test("probe: a busy lock is 429 store busy, separate from the rate limit", async () => {
  const raw = oauthRedis();
  raw.data.set(KEYS.probeLock, { type: "string", value: "holder-token" });
  const h = probeWith(raw, { lockWaitMs: 80 });
  const t0 = Date.now();
  const r = await call(h, { method: "POST", body: { code: "BUS111", agents: [] }, headers: { "x-forwarded-for": "203.0.113.80" } });
  assert.ok(Date.now() - t0 >= 80, "waiter backs off until the deadline");
  assert.ok(Date.now() - t0 < 2000, "waiter does not sit for the route budget");
  assert.equal(r.status, 429);
  assert.equal(r.body.error, LOCK_BUSY_ERROR);
  assert.notEqual(r.body.error, "too many requests");
  assert.equal(r.headers["retry-after"], "1");
  assert.equal(raw.data.has(KEYS.probe("BUS111")), false, "nothing stored");
  assert.equal(raw.data.get(KEYS.probeLock).value, "holder-token", "a busy waiter does not delete the holder");
  const sets = raw.calls.filter((c) => c[0] === "SET" && c[1] === KEYS.probeLock);
  assert.ok(sets.length >= 1 && sets.length < 40, `backoff, not a spin (${sets.length} SET NX)`);
});

test("probe: a lock that expires before the insert does not store a code", async () => {
  const raw = oauthRedis();
  const redis = async (cmd, ...args) => {
    const result = await raw(cmd, ...args);
    if (String(cmd).toUpperCase() === "GET" && args[0] === KEYS.probe("EXP001")) raw.data.delete(KEYS.probeLock);
    return result;
  };
  const h = probeWith(redis, { lockWaitMs: 200 });
  const r = await call(h, { method: "POST", body: { code: "EXP001", agents: [{ name: "claude", version: "1" }] }, headers: { "x-forwarded-for": "203.0.113.81" } });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, LOCK_BUSY_ERROR);
  assert.equal(r.headers["retry-after"], "1");
  assert.equal(raw.data.has(KEYS.probe("EXP001")), false);
  assert.equal(raw.data.get(KEYS.probeLive)?.value.size ?? 0, 0);
});

// ---- waitlist ----------------------------------------------------------------

test("waitlist: email shape, hashing by lowercased email, idempotent, only {ok:true}", async () => {
  const redis = oauthRedis();
  let t = 1000;
  const h = waitlistHandler({ redis: () => redis, now: () => t, log: quiet });
  for (const email of ["", "nope", "a@b", "a b@c.com", "<x>@y.com", 42, "a@-b.com", `${"a".repeat(250)}@b.com`]) {
    assert.equal((await call(h, { method: "POST", body: { email, agents: 3, plan: "pro" } })).status, 400, String(email));
  }
  assert.equal([...redis.data.keys()].some((k) => k.startsWith("lm:onboard:waitlist")), false);

  const r1 = await call(h, { method: "POST", body: { email: " Mikey@Example.com ", agents: 4, plan: "pro", extra: "dropped" } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { ok: true });
  const field = createHash("sha256").update("mikey@example.com").digest("hex");
  assert.equal(emailKey("mikey@example.com"), field);
  const entryKey = KEYS.waitlistEntry(field);
  const exp = 1000 + WAITLIST_TTL_S * 1000;
  assert.deepEqual(JSON.parse(redis.data.get(entryKey).value), { email: "mikey@example.com", hash: field, agents: 4, plan: "pro", ts: 1000, exp });
  assert.equal(redis.ttls.get(entryKey), WAITLIST_TTL_S, "retention TTL on the entry");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.get(field), exp / 1000);

  t = 5000;
  const r2 = await call(h, { method: "POST", body: { email: "MIKEY@example.COM", agents: 4, plan: "pro" } });
  assert.deepEqual(r2.body, { ok: true }, "a repeat looks the same as a first signup");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1, "one record per normalized email");
  const again = JSON.parse(redis.data.get(entryKey).value);
  assert.equal(again.ts, 1000, "first ts kept: same request twice, same record");
  assert.equal(again.exp, exp, "a repeat does not extend retention");
  assert.equal(redis.ttls.get(entryKey), WAITLIST_TTL_S - 4, "TTL counts down from the original expiry");

  const r3 = await call(h, { method: "POST", body: { email: "mikey@example.com", agents: "lots", plan: "platinum" }, headers: { "x-forwarded-for": "198.51.100.2" } });
  assert.equal(r3.status, 200, "(10 requests from the first IP used up its minute)");
  assert.deepEqual(JSON.parse(redis.data.get(entryKey).value), { email: "mikey@example.com", hash: field, agents: null, plan: null, ts: 1000, exp }, "bad agents/plan become null");
  assert.equal(normalizeEmail("x@y.co"), "x@y.co");
});

test("waitlist: rate limited to 10 per IP per minute; 503 without a backend", async () => {
  const redis = oauthRedis();
  const h = waitlistHandler({ redis: () => redis, log: quiet });
  const req = (i) => ({ method: "POST", body: { email: `u${i}@example.com` }, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  for (let i = 0; i < 10; i++) assert.equal((await call(h, req(i))).status, 200);
  const r = await call(h, req(11));
  assert.equal(r.status, 429);
  assert.equal(r.headers["retry-after"], "60");
  assert.equal(redis.ttls.get("lm:onboard:rl:wl:203.0.113.9"), 60);
  assert.equal((await call(h, { ...req(12), headers: { "x-forwarded-for": "198.51.100.7" } })).status, 200, "other IPs unaffected");
  assert.equal((await call(waitlistHandler({ redis: () => null, log: quiet }), req(1))).status, 503);
  assert.equal((await call(h, { method: "GET" })).status, 405);
});

test("waitlist: size cap, and retention deletes the plaintext email", async () => {
  const redis = oauthRedis();
  let now = 10_000;
  const ttlS = 50;
  const h = waitlistHandler({ redis: () => redis, now: () => now, maxEntries: 2, ttlS, log: quiet });
  const post = (email, ip = "203.0.113.40") => call(h, { method: "POST", body: { email, agents: 1, plan: "dev" }, headers: { "x-forwarded-for": ip } });
  assert.equal((await post("a@example.com")).status, 200);
  assert.equal((await post("A@Example.com")).status, 200, "normalized duplicate does not take a second slot");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1);
  assert.equal((await post("b@example.com")).status, 200);
  const full = await post("c@example.com");
  assert.equal(full.status, 503);
  assert.equal(full.body.error, "waitlist is full");
  assert.equal([...redis.data.values()].some((e) => e.type === "string" && String(e.value).includes("c@example.com")), false);
  assert.equal((await post("a@example.com", "203.0.113.41")).status, 200, "an address already on the list can still update");

  const aField = emailKey("a@example.com");
  const before = JSON.parse(redis.data.get(KEYS.waitlistEntry(aField)).value);
  now += 40 * 1000;
  assert.equal((await post("a@example.com", "203.0.113.42")).status, 200);
  const mid = JSON.parse(redis.data.get(KEYS.waitlistEntry(aField)).value);
  assert.equal(mid.exp, before.exp, "retention stays anchored to the first signup");
  assert.equal(redis.ttls.get(KEYS.waitlistEntry(aField)), 10);

  now = before.exp;
  assert.equal((await post("c@example.com", "203.0.113.43")).status, 200, "expired rows free a slot");
  const dumped = [...redis.data.entries()].filter(([k]) => k.startsWith("lm:onboard:waitlist:")).map(([, e]) => e.value);
  assert.equal(dumped.some((v) => String(v).includes("a@example.com") || String(v).includes("b@example.com")), false, "plaintext emails past retention are deleted");
  assert.equal(JSON.parse(redis.data.get(KEYS.waitlistEntry(emailKey("c@example.com"))).value).email, "c@example.com");
});

test("waitlist: a parallel burst never stores more than the size cap", async () => {
  const raw = oauthRedis();
  const stored = () => {
    const rows = [...raw.data.keys()].filter((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k)).length;
    const index = raw.data.get(KEYS.waitlistIndex)?.value.size ?? 0;
    return Math.max(rows, index);
  };
  const redis = observe(raw, stored);
  const cap = 3;
  const h = waitlistHandler({ redis: () => redis, maxEntries: cap, log: quiet });
  const n = 30;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => call(h, {
    method: "POST",
    body: { email: `burst${i}@example.com`, agents: 1, plan: "dev" },
    headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
  })));
  assert.equal(stored(), cap, "final rows and index sit on the cap");
  assert.ok(redis.high() <= cap, `high-water ${redis.high()} exceeded cap ${cap}`);
  assert.equal(results.filter((r) => r.status === 200).length, cap);
  const blocked = results.filter((r) => r.status === 503);
  assert.equal(blocked.length, n - cap);
  assert.ok(blocked.every((r) => r.body.error === "waitlist is full"));
  assert.equal(raw.data.has(KEYS.waitlistLock), false, "the lock is released");
  const kept = [...raw.data.entries()].find(([k, e]) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k) && e.type === "string");
  const email = JSON.parse(kept[1].value).email;
  const again = await call(h, {
    method: "POST",
    body: { email, agents: 2, plan: "pro" },
    headers: { "x-forwarded-for": "198.51.100.200" },
  });
  assert.equal(again.status, 200, "an address already on the list can still update when full");
  assert.deepEqual(again.body, { ok: true });
  assert.equal(stored(), cap, "the update does not take another slot");
  assert.ok(redis.high() <= cap);
});

test("waitlist: a busy lock is 429 store busy, separate from the rate limit", async () => {
  const raw = oauthRedis();
  raw.data.set(KEYS.waitlistLock, { type: "string", value: "holder-token" });
  const h = waitlistHandler({ redis: () => raw, lockWaitMs: 80, log: quiet });
  const r = await call(h, { method: "POST", body: { email: "busy@example.com" }, headers: { "x-forwarded-for": "203.0.113.82" } });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, LOCK_BUSY_ERROR);
  assert.notEqual(r.body.error, "too many requests");
  assert.equal(r.headers["retry-after"], "1");
  assert.equal([...raw.data.keys()].some((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k)), false);
  assert.equal(raw.data.get(KEYS.waitlistLock).value, "holder-token");
});

test("waitlist: a lock that expires before the insert does not store the email", async () => {
  const raw = oauthRedis();
  let zcards = 0;
  const redis = async (cmd, ...args) => {
    const result = await raw(cmd, ...args);
    if (String(cmd).toUpperCase() === "ZCARD" && args[0] === KEYS.waitlistIndex && ++zcards >= 2) raw.data.delete(KEYS.waitlistLock);
    return result;
  };
  const h = waitlistHandler({ redis: () => redis, lockWaitMs: 200, log: quiet });
  const r = await call(h, { method: "POST", body: { email: "expired-lock@example.com", agents: 1, plan: "dev" }, headers: { "x-forwarded-for": "203.0.113.83" } });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, LOCK_BUSY_ERROR);
  assert.equal([...raw.data.keys()].some((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k)), false);
  assert.equal(raw.data.get(KEYS.waitlistIndex)?.value.size ?? 0, 0);
});

test("waitlist: unparseable JSON takes the cap path", async () => {
  const redis = oauthRedis();
  const h = waitlistHandler({ redis: () => redis, maxEntries: 1, log: quiet });
  const post = (email, ip) => call(h, { method: "POST", body: { email, agents: 1, plan: "dev" }, headers: { "x-forwarded-for": ip } });
  const field = emailKey("a@example.com");
  redis.data.set(KEYS.waitlistEntry(field), { type: "string", value: "{not-json" });
  assert.equal((await post("a@example.com", "203.0.113.70")).status, 200, "under the cap, a corrupt row is replaced");
  assert.equal(JSON.parse(redis.data.get(KEYS.waitlistEntry(field)).value).email, "a@example.com");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1);

  const other = emailKey("b@example.com");
  redis.data.set(KEYS.waitlistEntry(other), { type: "string", value: "not json either" });
  const full = await post("b@example.com", "203.0.113.71");
  assert.equal(full.status, 503);
  assert.equal(full.body.error, "waitlist is full");
  assert.equal(redis.data.has(KEYS.waitlistEntry(other)), false, "the corrupt row is removed and the cap still refuses the signup");
  assert.equal([...redis.data.values()].some((e) => e.type === "string" && String(e.value).includes("b@example.com")), false);
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1);
});

test("store lock: ttl outlives the route, a landed SET that throws is deleted only when the token matches", async () => {
  assert.equal(probeConfig.maxDuration, ROUTE_MAX_DURATION_S);
  assert.equal(waitlistConfig.maxDuration, ROUTE_MAX_DURATION_S);
  assert.ok(LOCK_TTL_S > ROUTE_MAX_DURATION_S);
  assert.equal(LOCK_WAIT_MS, 2000);
  assert.ok(LOCK_WAIT_MS < ROUTE_MAX_DURATION_S * 1000);

  const raw = oauthRedis();
  await withStoreLock(raw, KEYS.probeLock, async (lock) => {
    await lock.requireHeld();
  });
  const set = raw.calls.find((c) => c[0] === "SET" && c[1] === KEYS.probeLock);
  assert.deepEqual(set.slice(3), ["NX", "EX", String(LOCK_TTL_S)]);
  assert.ok(!raw.calls.some((c) => c[0] === "EVAL"), "release does not depend on EVAL");
  assert.equal(raw.data.has(KEYS.probeLock), false, "matching token released");

  await withStoreLock(raw, KEYS.probeLock, async () => {
    raw.data.set(KEYS.probeLock, { type: "string", value: "newer-holder" });
  });
  assert.equal(raw.data.get(KEYS.probeLock).value, "newer-holder", "release does not delete a replaced token");

  const landed = oauthRedis();
  let ran = false;
  const throwing = (key, replace) => async (cmd, ...args) => {
    if (String(cmd).toUpperCase() === "SET" && args[0] === key && args[2] === "NX") {
      await landed(cmd, ...args);
      if (replace) landed.data.set(key, { type: "string", value: "newer-holder" });
      throw new Error("SET landed then failed");
    }
    return landed(cmd, ...args);
  };
  await assert.rejects(withStoreLock(throwing(KEYS.probeLock, false), KEYS.probeLock, async () => { ran = true; }), /SET landed then failed/);
  assert.equal(ran, false, "fn does not run after a failed acquire");
  assert.equal(landed.data.has(KEYS.probeLock), false, "a token that landed and then threw is deleted");

  await assert.rejects(withStoreLock(throwing(KEYS.waitlistLock, true), KEYS.waitlistLock, async () => { ran = true; }), /SET landed then failed/);
  assert.equal(ran, false);
  assert.equal(landed.data.get(KEYS.waitlistLock).value, "newer-holder", "a different token is left in place");

  const times = [];
  const busy = async (cmd) => {
    assert.equal(String(cmd).toUpperCase(), "SET");
    times.push(Date.now());
    return null;
  };
  const t0 = Date.now();
  await assert.rejects(withStoreLock(busy, "lm:onboard:lock:test", async () => { ran = true; }, { waitMs: 220 }), (e) => e instanceof StoreLockError && e.message === LOCK_BUSY_ERROR);
  const elapsed = Date.now() - t0;
  assert.equal(ran, false);
  assert.ok(elapsed >= 220 && elapsed < 800, `deadline ${elapsed}ms`);
  assert.ok(times.length >= 2 && times.length <= 30, `backoff attempts ${times.length}, not 800`);
  assert.ok(times[1] - times[0] >= 5, "the retry waits instead of spinning");
});

// ---- connection test ----------------------------------------------------------

function fakeFetch(replies = { PING: "PONG", TYPE: "none", EXISTS: 0 }) {
  const calls = [];
  const f = async (url, init) => {
    const cmd = JSON.parse(init.body);
    calls.push({ url, init, cmd });
    if (replies instanceof Error) throw replies;
    const v = replies[cmd[0]];
    if (v instanceof Error) return { ok: true, json: async () => ({ error: v.message }) };
    return { ok: true, json: async () => ({ result: v }) };
  };
  f.calls = calls;
  return f;
}

test("test endpoint: SSRF guard refuses private, loopback, metadata and plaintext targets", async () => {
  const redis = oauthRedis();
  const fetchImpl = fakeFetch();
  let nativeCalls = 0;
  const h = testHandler({ redis: () => redis, fetchImpl, native: async () => { nativeCalls++; return async () => "PONG"; }, log: quiet });
  const targets = [
    { kind: "rest", url: "https://127.0.0.1", token: "t" },
    { kind: "rest", url: "https://10.1.2.3/", token: "t" },
    { kind: "rest", url: "https://169.254.169.254/latest", token: "t" },
    { kind: "rest", url: "https://[::1]", token: "t" },
    { kind: "rest", url: "https://[::ffff:192.168.0.1]", token: "t" },
    { kind: "rest", url: "http://93.184.216.34", token: "t" },
    { kind: "rest", url: "https://93.184.216.34:8443", token: "t" },
    { kind: "redis", uri: "redis://:pw@93.184.216.34:6379" },
    { kind: "redis", uri: "rediss://:pw@192.168.1.10:6379" },
    { kind: "redis", uri: "rediss://:pw@[fd00:ec2::254]:6379" },
  ];
  for (const body of targets) {
    const r = await call(h, { method: "POST", body, headers: { "x-forwarded-for": `198.51.100.${targets.indexOf(body)}` } });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, REFUSED);
    assert.ok(!r.raw.includes("pw") && !r.raw.includes("169.254"), "nothing echoed");
  }
  assert.equal(fetchImpl.calls.length, 0, "no request left the server");
  assert.equal(nativeCalls, 0);
});

test("test endpoint: read-only commands only, no redirects, no credentials in the reply", async () => {
  const redis = oauthRedis();
  const fetchImpl = fakeFetch();
  const h = testHandler({ redis: () => redis, guard: async () => {}, fetchImpl, log: quiet });
  const r = await call(h, { method: "POST", body: { kind: "rest", url: "https://eu1.example.upstash.io", token: "SECRET-TOKEN" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, reachable: true, results: [{ cmd: "PING", ok: true }, { cmd: "TYPE", ok: true }, { cmd: "EXISTS", ok: true }] });
  assert.ok(!r.raw.includes("SECRET") && !r.raw.includes("upstash"));
  assert.deepEqual(fetchImpl.calls.map((c) => c.cmd[0]), ["PING", "TYPE", "EXISTS"]);
  const key = fetchImpl.calls[1].cmd[1];
  assert.match(key, /^lm:probe:onboard:[0-9a-f]{24}$/);
  assert.equal(fetchImpl.calls[2].cmd[1], key, "TYPE and EXISTS hit the same random key");
  for (const c of fetchImpl.calls) {
    assert.equal(c.init.redirect, "manual");
    assert.ok(c.init.signal, "bounded by a timeout");
    assert.equal(c.cmd.length <= 2, true);
  }
  assert.equal(fetchImpl.calls[0].url, "https://eu1.example.upstash.io/", "restEndpoint normalisation");
  assert.deepEqual([...redis.data.keys()].filter((k) => !k.startsWith("lm:onboard:rl:")), [], "only the rate-limit counter on our side");
});

test("test endpoint: failures are generic; refused commands are reported", async () => {
  const redis = oauthRedis();
  const down = testHandler({ redis: () => redis, guard: async () => {}, fetchImpl: fakeFetch(new Error("getaddrinfo ENOTFOUND secret-host.internal")), log: quiet });
  const r = await call(down, { method: "POST", body: { kind: "rest", url: "https://secret-host.example", token: "t" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reachable, false);
  assert.equal(r.body.error, CONNECT_FAILED);
  assert.ok(!r.raw.includes("secret-host"));

  const acl = testHandler({ redis: () => redis, guard: async () => {}, fetchImpl: fakeFetch({ PING: "PONG", TYPE: new Error("NOPERM"), EXISTS: 0 }), log: quiet });
  const a = await call(acl, { method: "POST", body: { kind: "rest", url: "https://x.example", token: "t" } });
  assert.deepEqual(a.body, { ok: false, reachable: true, results: [{ cmd: "PING", ok: true }, { cmd: "TYPE", ok: false }, { cmd: "EXISTS", ok: true }] });

  let closed = false;
  const nat = testHandler({ redis: () => redis, guard: async () => {}, native: async () => Object.assign(async (c) => (c === "PING" ? "PONG" : 0), { close: async () => { closed = true; } }), log: quiet });
  const n = await call(nat, { method: "POST", body: { kind: "redis", uri: "rediss://:pw@redis.example:6380" } });
  assert.equal(n.body.ok, true);
  assert.equal(closed, true, "native connection closed after the test");

  const bad = testHandler({ redis: () => redis, guard: async () => {}, log: quiet });
  assert.equal((await call(bad, { method: "POST", body: { kind: "ftp" } })).status, 400);
  assert.equal((await call(bad, { method: "POST", body: { kind: "rest", url: "https://x" } })).status, 400, "token required");
  assert.equal((await call(bad, { method: "POST", body: { kind: "rest", url: "https://x", token: "t".repeat(5000) } })).status, 413);
  assert.equal((await call(testHandler({ redis: () => null, log: quiet }), { method: "POST", body: {} })).status, 503);
});

test("test endpoint: 10 per IP per minute (INCR + EXPIRE 60), checked before the guard", async () => {
  const redis = oauthRedis();
  let guarded = 0;
  const h = testHandler({ redis: () => redis, guard: async () => { guarded++; throw new Error("no"); }, log: quiet });
  const req = { method: "POST", body: { kind: "rest", url: "https://x.example", token: "t" }, headers: { "x-forwarded-for": "203.0.113.50" } };
  for (let i = 0; i < 10; i++) assert.equal((await call(h, req)).status, 400);
  const r = await call(h, req);
  assert.equal(r.status, 429);
  assert.equal(guarded, 10, "the 11th request never reached the guard");
  assert.equal(redis.data.get("lm:onboard:rl:203.0.113.50").value, "11");
  assert.equal(redis.ttls.get("lm:onboard:rl:203.0.113.50"), 60);
  assert.equal(redis.calls.filter((c) => c[0] === "EXPIRE").length, 1, "EXPIRE only on the first hit");
});

test("connection pin: dial the checked address, keep SNI and Host, refuse redis://", async () => {
  const pin = { protocol: "rediss:", hostname: "redis.example", port: 6380, addresses: ["8.8.4.4", "1.1.1.1"] };
  const opts = pinnedNativeOptions("rediss://:s3cret@redis.example:6380/0", pin);
  assert.equal(opts.socket.host, "8.8.4.4", "TCP target is the first checked address");
  assert.equal(opts.socket.servername, "redis.example", "SNI stays the original name");
  assert.equal(opts.socket.tls, true);
  assert.equal(opts.socket.rejectUnauthorized, true);
  assert.equal(opts.socket.reconnectStrategy, false);
  assert.equal(opts.password, "s3cret");
  assert.equal(JSON.stringify(opts.socket).includes("s3cret"), false, "the secret is not on the socket options");
  assert.equal(opts.database, 0);
  const all = await new Promise((resolve, reject) => opts.socket.lookup("redis.example", { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))));
  assert.deepEqual(all, [{ address: "8.8.4.4", family: 4 }]);
  const one = await new Promise((resolve, reject) => opts.socket.lookup("redis.example", (err, addr, fam) => (err ? reject(err) : resolve({ addr, fam }))));
  assert.deepEqual(one, { addr: "8.8.4.4", fam: 4 });
  await assert.rejects(new Promise((resolve, reject) => opts.socket.lookup("evil.example", {}, (err, addr) => (err ? reject(err) : resolve(addr)))));

  assert.throws(() => pinnedNativeOptions("redis://:s3cret@93.184.216.34:6379", { protocol: "redis:", hostname: "93.184.216.34", port: 6379, addresses: ["93.184.216.34"] }), (e) => e instanceof PinError && !String(e.message).includes("s3cret"));
  assert.throws(() => pinnedNativeOptions("rediss://:pw@redis.example:6380", { ...pin, addresses: ["169.254.169.254"] }), PinError);
  assert.throws(() => pinnedNativeOptions("rediss://:pw@other.example:6380", pin), PinError);

  const httpsOpts = pinnedHttpsOptions("https://eu1.example.upstash.io/path", { protocol: "https:", hostname: "eu1.example.upstash.io", port: 443, addresses: ["1.2.3.4"] });
  assert.equal(httpsOpts.host, "1.2.3.4");
  assert.equal(httpsOpts.servername, "eu1.example.upstash.io");
  assert.equal(httpsOpts.headers.Host, "eu1.example.upstash.io");
  assert.equal(httpsOpts.path, "/path");
  assert.equal(httpsOpts.rejectUnauthorized, true);
  const withPort = pinnedHttpsOptions("https://redis.example:8443/x", { protocol: "https:", hostname: "redis.example", port: 8443, addresses: ["8.8.4.4"] });
  assert.equal(withPort.headers.Host, "redis.example:8443");
  assert.equal(withPort.servername, "redis.example");
  assert.equal(withPort.port, 8443);
  const literal = pinnedHttpsOptions("https://93.184.216.34/x", { protocol: "https:", hostname: "93.184.216.34", port: 443, addresses: ["93.184.216.34"] });
  assert.equal(literal.servername, undefined, "an IP literal has no SNI name");
  assert.equal(literal.headers.Host, "93.184.216.34");
  assert.throws(() => pinnedHttpsOptions("http://eu1.example.upstash.io/", { protocol: "http:", hostname: "eu1.example.upstash.io", port: 80, addresses: ["1.2.3.4"] }), PinError);

  // The lookup is what Node dials. Host stays the original name.
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.host); res.end("ok"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: "not-a-real-host.example",
        port,
        lookup: pinLookup("not-a-real-host.example", "127.0.0.1"),
        method: "POST",
        path: "/",
        headers: { Host: "not-a-real-host.example" },
      }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(seen, ["not-a-real-host.example"]);
});

test("connection pin: handler uses the guard's address and still refuses plaintext and rebinding", async () => {
  const redis = oauthRedis();
  let dnsCalls = 0;
  const lookup = async () => {
    dnsCalls++;
    return [{ address: dnsCalls === 1 ? "8.8.4.4" : "169.254.169.254", family: 4 }];
  };
  let nativePin = null;
  const native = async (uri, pin) => {
    nativePin = { uri, pin, opts: pinnedNativeOptions(uri, pin) };
    return Object.assign(async (c) => (c === "PING" ? "PONG" : 0), { close: async () => {} });
  };
  const h = testHandler({
    redis: () => redis,
    guard: (target) => assertPublicTarget(target, { env: {}, lookup }),
    fetchImpl: async () => { throw new Error("unpinned fetch"); },
    native,
    log: quiet,
  });
  const r = await call(h, { method: "POST", body: { kind: "redis", uri: "rediss://:s3cret@redis.example:6380" }, headers: { "x-forwarded-for": "203.0.113.60" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(dnsCalls, 1, "the connection did not resolve the name again");
  assert.equal(nativePin.opts.socket.host, "8.8.4.4");
  assert.equal(nativePin.opts.socket.servername, "redis.example");
  assert.ok(!r.raw.includes("s3cret") && !r.raw.includes("8.8.4.4"));

  const requests = [];
  const requestImpl = (options, cb) => {
    requests.push(options);
    const res = {
      statusCode: 200,
      on(ev, fn) {
        if (ev === "data") fn(Buffer.from(JSON.stringify({ result: "PONG" })));
        if (ev === "end") fn();
        return this;
      },
    };
    return { on() { return this; }, setTimeout() { return this; }, destroy() {}, end() { cb(res); } };
  };
  const rest = testHandler({
    redis: () => redis,
    guard: async () => ({ protocol: "https:", hostname: "eu1.example.upstash.io", port: 443, addresses: ["1.2.3.4"] }),
    fetchImpl: async () => { throw new Error("unpinned fetch"); },
    requestImpl,
    log: quiet,
  });
  const rr = await call(rest, { method: "POST", body: { kind: "rest", url: "https://eu1.example.upstash.io", token: "SECRET-TOKEN" }, headers: { "x-forwarded-for": "203.0.113.61" } });
  assert.equal(rr.body.reachable, true);
  assert.equal(requests.length >= 1, true);
  assert.equal(requests[0].host, "1.2.3.4");
  assert.equal(requests[0].servername, "eu1.example.upstash.io");
  assert.equal(requests[0].headers.Host, "eu1.example.upstash.io");
  assert.equal(requests[0].headers.Authorization, "Bearer SECRET-TOKEN");
  assert.ok(!rr.raw.includes("SECRET-TOKEN"));
  const looked = await new Promise((resolve, reject) => requests[0].lookup("eu1.example.upstash.io", { all: true }, (err, a) => (err ? reject(err) : resolve(a))));
  assert.deepEqual(looked, [{ address: "1.2.3.4", family: 4 }]);

  // A 302 is not followed.
  let redirects = 0;
  const once = (options, cb) => {
    redirects++;
    const res = { statusCode: 302, on(ev, fn) { if (ev === "end") fn(); return this; } };
    return { on() { return this; }, setTimeout() { return this; }, destroy() {}, end() { cb(res); } };
  };
  const moved = await pinnedHttpsPost("https://eu1.example.upstash.io/", "t", ["PING"], {
    pin: { protocol: "https:", hostname: "eu1.example.upstash.io", port: 443, addresses: ["1.2.3.4"] },
    requestImpl: once,
  });
  assert.equal(moved.ok, false);
  assert.equal(redirects, 1);

  await withEnv({ LOGMEM_ALLOW_PLAINTEXT_REDIS: "1" }, async () => {
    let nativeCalls = 0;
    const plain = testHandler({
      redis: () => redis,
      fetchImpl: async () => { throw new Error("fetch"); },
      native: async () => { nativeCalls++; return async () => "PONG"; },
      log: quiet,
    });
    const pr = await call(plain, { method: "POST", body: { kind: "redis", uri: "redis://:s3cret@93.184.216.34:6379" }, headers: { "x-forwarded-for": "203.0.113.62" } });
    assert.equal(pr.status, 400);
    assert.equal(pr.body.error, REFUSED);
    assert.equal(nativeCalls, 0);
    assert.ok(!pr.raw.includes("s3cret"));
  });

  const mixed = testHandler({
    redis: () => redis,
    guard: async () => ({ protocol: "https:", hostname: "ok.example", port: 443, addresses: ["8.8.8.8", "169.254.169.254"] }),
    fetchImpl: async () => { throw new Error("fetch"); },
    log: quiet,
  });
  const mr = await call(mixed, { method: "POST", body: { kind: "rest", url: "https://ok.example", token: "t" }, headers: { "x-forwarded-for": "203.0.113.63" } });
  assert.equal(mr.status, 400);
  assert.equal(mr.body.error, REFUSED);
});

test("runTest stops after a failed PING", async () => {
  const seen = [];
  const out = await runTest(async (...c) => { seen.push(c[0]); throw new Error("down"); });
  assert.deepEqual(seen, ["PING"]);
  assert.equal(out.reachable, false);
});

// ---- shared helpers -------------------------------------------------------------

test("helpers: clientIp, rateLimit recovery, readJsonBody", async () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" } }), "203.0.113.1");
  assert.equal(clientIp({ headers: { "x-real-ip": "2001:DB8::1" } }), "2001:db8::1");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "evil:*{}key" } }), "e:e");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
  assert.equal(clientIp({ headers: {} }), "unknown");

  const redis = oauthRedis();
  redis.data.set("lm:onboard:rl:1.2.3.4", { type: "string", value: "50" }); // a counter whose EXPIRE was lost
  const r = await rateLimit(redis, "1.2.3.4");
  assert.equal(r.ok, false);
  assert.equal(redis.ttls.get("lm:onboard:rl:1.2.3.4"), 60, "expiry re-applied");

  assert.throws(() => readJsonBody({ headers: {}, body: "{nope" }, 100), /invalid JSON/);
  assert.throws(() => readJsonBody({ headers: {}, body: null }, 100), /object body/);
  assert.deepEqual(readJsonBody({ headers: {}, body: Buffer.from('{"a":1}') }, 100), { a: 1 });
});

test("probe.sh parses as POSIX sh", () => {
  const script = fileURLToPath(new URL("../public/probe.sh", import.meta.url));
  execFileSync("sh", ["-n", script]);
});
