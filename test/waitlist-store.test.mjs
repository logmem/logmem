// Waitlist storage: no expiry, no cap, no global lock, a stream copy, a Blob copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, mockRes, mockReq } from "./oauth-helpers.mjs";
import { cleanAttribution, saveSignup } from "../src/http/waitlist-store.mjs";
import { createHandler as waitlistHandler, emailKey } from "../api/onboarding/waitlist.mjs";
import { KEYS } from "../src/http/onboarding.mjs";

const quiet = () => {};
const call = async (handler, opts) => {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, headers: res.headers };
};
const row = (redis, email) => JSON.parse(redis.data.get(KEYS.waitlistEntry(emailKey(email))).value);
const streamLen = async (redis) => Number(await redis("XLEN", KEYS.waitlistLog));

test("memory-redis: XADD appends with ids that only grow, XLEN and XRANGE read them back", async () => {
  const redis = createMemoryRedis();
  assert.equal(await redis("XLEN", "s"), 0);
  const a = await redis("XADD", "s", "*", "k", "v1");
  const b = await redis("XADD", "s", "*", "k", "v2", "n", 3);
  assert.match(a, /^\d+-\d+$/);
  const [am, as] = a.split("-").map(Number);
  const [bm, bs] = b.split("-").map(Number);
  assert.ok(bm > am || (bm === am && bs > as), "ids grow");
  assert.equal(await redis("XLEN", "s"), 2);
  assert.deepEqual(await redis("XRANGE", "s", "-", "+"), [[a, ["k", "v1"]], [b, ["k", "v2", "n", "3"]]]);
  assert.equal(await redis("TYPE", "s"), "stream");
  await assert.rejects(redis("GET", "s"), /WRONGTYPE/);
  await assert.rejects(redis("XADD", "s", "1-1", "k", "v"), /only "\*"/);
});

test("cleanAttribution: cuts and cleans HTML, long and non-ASCII values, never throws", () => {
  const empty = { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, referrer_host: null, landing_path: null, first_seen: null };
  for (const raw of [null, undefined, "x", 42, [], { utm_source: { a: 1 } }]) assert.deepEqual(cleanAttribution(raw), empty);

  const a = cleanAttribution({
    utm_source: "<script>alert(1)</script>",
    utm_medium: "x".repeat(500),
    utm_campaign: "Café Spring Sale",
    utm_term: "日本語",
    utm_content: "  ok_1.2~a/b-c  ",
    referrer_host: "https://News.Ycombinator.com/item?id=1&email=a@b.com",
    landing_path: "/onboarding?email=a@b.com#x",
    first_seen: 1782838427423.7,
    extra: "dropped",
  });
  assert.equal(a.utm_source, "script-alert-1-/script");
  assert.equal(a.utm_medium.length, 100);
  assert.equal(a.utm_campaign, "Cafe-Spring-Sale");
  assert.equal(a.utm_term, null, "nothing left after cleaning is null");
  assert.equal(a.utm_content, "ok_1.2~a/b-c");
  assert.equal(a.referrer_host, "news.ycombinator.com", "host only, no path or query");
  assert.equal(a.landing_path, "/onboarding", "no query or fragment");
  assert.equal(a.first_seen, 1782838427423);
  assert.equal("extra" in a, false);
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === "string") assert.match(v, /^[A-Za-z0-9._~/-]+$/, k);
  }
  assert.equal(cleanAttribution({ landing_path: `/${"p".repeat(400)}` }).landing_path.length, 200);
  assert.equal(cleanAttribution({ referrer_host: "Example.org" }).referrer_host, "example.org", "a bare host works");
  assert.equal(cleanAttribution({ referrer_host: "<b>not a host</b>" }).referrer_host, null);
  assert.equal(cleanAttribution({ first_seen: "soon" }).first_seen, null);
  assert.equal(cleanAttribution({ first_seen: -5 }).first_seen, null);
});

test("saveSignup: a new row has no TTL and no exp; the index and the stream each grow by one", async () => {
  const redis = oauthRedis();
  const r = await saveSignup(redis, { email: "a@example.com", agents: 3, plan: "pro", attribution: { utm_source: "hn" }, now: 5000 });
  assert.deepEqual(r, { created: true });
  const key = KEYS.waitlistEntry(emailKey("a@example.com"));
  assert.equal(await redis("TTL", key), -1, "no expiry");
  const stored = row(redis, "a@example.com");
  assert.equal("exp" in stored, false);
  assert.deepEqual(stored, {
    email: "a@example.com",
    hash: emailKey("a@example.com"),
    agents: 3,
    plan: "pro",
    ts: 5000,
    last_ts: 5000,
    count: 1,
    attribution: { ...cleanAttribution(null), utm_source: "hn" },
  });
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.get(emailKey("a@example.com")), 5);
  const set = redis.calls.find((c) => c[0] === "SET" && c[1] === key);
  assert.deepEqual(set.slice(3), ["NX"], "the first write is SET NX with no EX");
  assert.equal(await streamLen(redis), 1);
  const [[, fields]] = await redis("XRANGE", KEYS.waitlistLog, "-", "+");
  assert.deepEqual(fields, ["hash", emailKey("a@example.com"), "email", "a@example.com", "plan", "pro", "src", "hn", "ts", "5000"]);

  await saveSignup(redis, { email: "b@example.com", agents: null, plan: null, attribution: null, now: 6000 });
  assert.equal(await streamLen(redis), 2, "stream grows by one per call");
  const [, [, second]] = await redis("XRANGE", KEYS.waitlistLog, "-", "+");
  assert.deepEqual(second.slice(4, 8), ["plan", "", "src", ""], "missing plan and source are empty strings");
});

test("saveSignup: a repeat keeps the first ts and attribution, updates plan and agents, counts, and is not a second row", async () => {
  const redis = oauthRedis();
  await saveSignup(redis, { email: "a@example.com", agents: 3, plan: "dev", attribution: { utm_source: "first" }, now: 1000 });
  const r = await saveSignup(redis, { email: "a@example.com", agents: 9, plan: "team", attribution: { utm_source: "second" }, now: 9000 });
  assert.deepEqual(r, { created: false });
  const stored = row(redis, "a@example.com");
  assert.equal(stored.ts, 1000);
  assert.equal(stored.last_ts, 9000);
  assert.equal(stored.count, 2);
  assert.equal(stored.plan, "team");
  assert.equal(stored.agents, 9);
  assert.equal(stored.attribution.utm_source, "first", "first attribution kept");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, 1, "one row per email");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.get(emailKey("a@example.com")), 1, "index keeps the first second");
  assert.equal(await streamLen(redis), 2, "the stream records every sign-up, repeats too");
});

test("saveSignup: an old-shape row with exp is upgraded on repeat without losing ts, and its TTL is cleared", async () => {
  const redis = oauthRedis();
  const field = emailKey("old@example.com");
  const key = KEYS.waitlistEntry(field);
  const old = { email: "old@example.com", hash: field, agents: 2, plan: "free", ts: 700, exp: 700 + 180 * 86400 * 1000 };
  await redis("SET", key, JSON.stringify(old), "EX", "15552000");
  await redis("ZADD", KEYS.waitlistIndex, String(Math.floor(old.exp / 1000)), field);
  assert.equal(await redis("TTL", key), 15552000);

  await saveSignup(redis, { email: "old@example.com", agents: 5, plan: "pro", attribution: { utm_source: "late" }, now: 50_000 });
  const up = row(redis, "old@example.com");
  assert.equal(up.ts, 700, "first ts kept");
  assert.equal("exp" in up, false, "exp dropped");
  assert.equal(up.count, 2, "an old row counts as one earlier sign-up");
  assert.equal(up.last_ts, 50_000);
  assert.equal(up.plan, "pro");
  assert.equal(up.attribution.utm_source, "late", "an old row had no attribution, so this one is the first");
  assert.equal(await redis("TTL", key), -1, "the upgrade removes the old expiry");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.get(field), 0, "index score moves from expiry to first sign-up second");
});

test("saveSignup: a stored value that is not JSON is replaced by a fresh row", async () => {
  const redis = oauthRedis();
  const key = KEYS.waitlistEntry(emailKey("bad@example.com"));
  redis.data.set(key, { type: "string", value: "{not-json" });
  const r = await saveSignup(redis, { email: "bad@example.com", agents: 1, plan: "dev", attribution: null, now: 3000 });
  assert.deepEqual(r, { created: true });
  assert.equal(row(redis, "bad@example.com").ts, 3000);
  assert.equal(row(redis, "bad@example.com").count, 1);
});

test("saveSignup: Blob gets one private JSON file per sign-up; a Blob error is dropped and logs no personal data", async () => {
  const redis = oauthRedis();
  const puts = [];
  const blobPut = async (path, body) => { puts.push([path, body]); };
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  await saveSignup(redis, { email: "a@example.com", agents: 1, plan: "dev", attribution: { utm_source: "hn" }, now, blobPut });
  assert.equal(puts.length, 1);
  assert.equal(puts[0][0], `waitlist/2026-10-15/${now}-${emailKey("a@example.com")}.json`);
  assert.deepEqual(JSON.parse(puts[0][1]), row(redis, "a@example.com"));

  const lines = [];
  const failing = async () => { throw new Error("blob down for a@example.com from 203.0.113.9 via hn"); };
  const r = await saveSignup(redis, { email: "c@example.com", agents: 1, plan: "dev", attribution: { utm_source: "secret-src" }, now, blobPut: failing, log: (l) => lines.push(l) });
  assert.deepEqual(r, { created: true });
  assert.equal(row(redis, "c@example.com").email, "c@example.com", "the row is in Redis");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines.join("\n"), /@|203\.0\.113|secret-src|hn/);
  assert.match(lines[0], /blob/);

  const hanging = () => new Promise(() => {});
  const t0 = Date.now();
  await saveSignup(redis, { email: "d@example.com", agents: 1, plan: "dev", attribution: null, now, blobPut: hanging, blobTimeoutMs: 30, log: quiet });
  assert.ok(Date.now() - t0 < 1000, "a hung Blob call does not hold the sign-up");
});

test("saveSignup: a stream error does not fail the sign-up and logs no personal data", async () => {
  const raw = oauthRedis();
  const redis = async (cmd, ...args) => {
    if (String(cmd).toUpperCase() === "XADD") throw new Error("XADD refused for a@example.com");
    return raw(cmd, ...args);
  };
  const lines = [];
  const r = await saveSignup(redis, { email: "a@example.com", agents: 1, plan: "dev", attribution: null, now: 1000, log: (l) => lines.push(l) });
  assert.deepEqual(r, { created: true });
  assert.equal(row(raw, "a@example.com").email, "a@example.com");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /@/);
});

test("waitlist handler: a parallel burst stores all, with no 429 from a lock", async () => {
  const redis = oauthRedis();
  const h = waitlistHandler({ redis: () => redis, log: quiet, blobPut: null });
  const n = 50;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => call(h, {
    method: "POST",
    body: { email: `burst${i}@example.com`, agents: 1, plan: "dev" },
    headers: { "x-forwarded-for": `198.51.100.${i + 1}` },
  })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.filter((r) => r.status !== 200).map((r) => r.status)));
  const rows = [...redis.data.keys()].filter((k) => /^lm:onboard:waitlist:[0-9a-f]{64}$/.test(k));
  assert.equal(rows.length, n, "all 50 stored");
  assert.equal(redis.data.get(KEYS.waitlistIndex).value.size, n);
  assert.equal(await streamLen(redis), n);
  assert.equal(redis.calls.some((c) => c[1] === KEYS.waitlistLock), false, "no lock taken");
});

test("waitlist handler: attribution is stored cleaned; Blob throwing still answers {ok:true}", async () => {
  const redis = oauthRedis();
  const h = waitlistHandler({ redis: () => redis, log: quiet, blobPut: async () => { throw new Error("no blob"); } });
  const r = await call(h, {
    method: "POST",
    body: { email: "x@example.com", agents: 2, plan: "pro", attribution: { utm_source: "<b>news</b>", utm_campaign: "y".repeat(300), referrer_host: "https://t.co/abc", landing_path: "/", first_seen: 1234 } },
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const a = row(redis, "x@example.com").attribution;
  assert.equal(a.utm_source, "b-news-/b");
  assert.equal(a.utm_campaign.length, 100);
  assert.equal(a.referrer_host, "t.co");
  assert.equal(a.first_seen, 1234);

  const junk = await call(h, { method: "POST", body: { email: "y@example.com", attribution: "not an object" }, headers: { "x-forwarded-for": "203.0.113.5" } });
  assert.equal(junk.status, 200, "bad attribution is never a reason to refuse");
});

test("waitlist handler: 30 per IP per minute, then 429", async () => {
  const redis = oauthRedis();
  const h = waitlistHandler({ redis: () => redis, log: quiet, blobPut: null });
  const req = (i) => ({ method: "POST", body: { email: `u${i}@example.com` }, headers: { "x-forwarded-for": "203.0.113.9" } });
  for (let i = 0; i < 30; i++) assert.equal((await call(h, req(i))).status, 200, `request ${i + 1}`);
  assert.equal((await call(h, req(31))).status, 429);
});
