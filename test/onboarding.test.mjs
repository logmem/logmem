// /api/onboarding/* — probe pairing, hosted waitlist, connection test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { oauthRedis, mockRes, mockReq } from "./oauth-helpers.mjs";
import { createHandler as probeHandler, cleanAgents, TTL_S } from "../api/onboarding/probe.mjs";
import { createHandler as waitlistHandler, normalizeEmail, emailKey } from "../api/onboarding/waitlist.mjs";
import { createHandler as testHandler, runTest, REFUSED, CONNECT_FAILED } from "../api/onboarding/test.mjs";
import { clientIp, rateLimit, readJsonBody, KEYS } from "../src/http/onboarding.mjs";

const quiet = () => {};
const call = async (handler, opts) => {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, raw: res.body, headers: res.headers };
};
const get = (handler, code) => call(handler, { method: "GET", url: `/api/onboarding/probe?code=${code}` }).then((r) => r);

function probeWith(redis) {
  const h = probeHandler({ redis: () => redis, log: quiet });
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
  assert.equal(redis.data.size, 0, "nothing stored");
});

test("probe: body over 2 KB is refused before anything is stored", async () => {
  const redis = oauthRedis();
  const h = probeWith(redis);
  const big = { code: "ABC123", agents: [{ name: "claude", version: "x".repeat(3000) }] };
  assert.equal((await call(h, { method: "POST", body: big })).status, 413);
  assert.equal((await call(h, { method: "POST", body: JSON.stringify(big) })).status, 413, "raw string body");
  assert.equal((await call(h, { method: "POST", body: { code: "ABC123", agents: [] }, headers: { "content-length": "4096" } })).status, 413, "declared length");
  assert.equal(redis.data.size, 0);
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
  const set = redis.calls.find((c) => c[0] === "SET");
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

// ---- waitlist ----------------------------------------------------------------

test("waitlist: email shape, hashing by lowercased email, idempotent, only {ok:true}", async () => {
  const redis = oauthRedis();
  let t = 1000;
  const h = waitlistHandler({ redis: () => redis, now: () => t, log: quiet });
  for (const email of ["", "nope", "a@b", "a b@c.com", "<x>@y.com", 42, "a@-b.com", `${"a".repeat(250)}@b.com`]) {
    assert.equal((await call(h, { method: "POST", body: { email, agents: 3, plan: "pro" } })).status, 400, String(email));
  }
  assert.equal(redis.data.has(KEYS.waitlist), false);

  const r1 = await call(h, { method: "POST", body: { email: " Mikey@Example.com ", agents: 4, plan: "pro", extra: "dropped" } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { ok: true });
  const field = createHash("sha256").update("mikey@example.com").digest("hex");
  assert.equal(emailKey("mikey@example.com"), field);
  const hash = redis.data.get(KEYS.waitlist).value;
  assert.deepEqual(JSON.parse(hash.get(field)), { email: "mikey@example.com", agents: 4, plan: "pro", ts: 1000 });

  t = 5000;
  const r2 = await call(h, { method: "POST", body: { email: "MIKEY@example.COM", agents: 4, plan: "pro" } });
  assert.deepEqual(r2.body, { ok: true }, "a repeat looks the same as a first signup");
  assert.equal(hash.size, 1, "one record per email");
  assert.equal(JSON.parse(hash.get(field)).ts, 1000, "first ts kept: same request twice, same record");

  const r3 = await call(h, { method: "POST", body: { email: "mikey@example.com", agents: "lots", plan: "platinum" }, headers: { "x-forwarded-for": "198.51.100.2" } });
  assert.equal(r3.status, 200, "(10 requests from the first IP used up its minute)");
  assert.deepEqual(JSON.parse(hash.get(field)), { email: "mikey@example.com", agents: null, plan: null, ts: 1000 }, "bad agents/plan become null");
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
