// GET /api/waitlist: the admin list of waitlist sign-ups, counts and CSV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, mockRes, mockReq } from "./oauth-helpers.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { KEYS } from "../src/http/onboarding.mjs";
import { saveSignup } from "../src/http/waitlist-store.mjs";
import { emailKey } from "../api/onboarding/waitlist.mjs";
import { createHandler, csvCell } from "../api/waitlist.mjs";

const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production" };
const cookie = issueCookie(ENV).split(";")[0];

const call = async (handler, { url = "/api/waitlist", method = "GET", headers = {} } = {}) => {
  const req = mockReq({ method, url, headers });
  req.query = Object.fromEntries(new URL(url, "http://x").searchParams);
  const res = mockRes();
  await handler(req, res);
  const json = String(res.headers["content-type"] || "").includes("json") || !res.headers["content-type"];
  return { status: res.statusCode, headers: res.headers, raw: res.body, body: json && res.body ? JSON.parse(res.body) : undefined };
};

async function seed() {
  const redis = oauthRedis();
  const day1 = Date.UTC(2026, 9, 14, 9, 0, 0);
  const day2 = Date.UTC(2026, 9, 15, 9, 0, 0);
  // An old-shape row, written before attribution existed.
  const oldField = emailKey("old@example.com");
  await redis("SET", KEYS.waitlistEntry(oldField), JSON.stringify({ email: "old@example.com", hash: oldField, agents: 2, plan: "free", ts: day1, exp: day1 + 1e10 }), "EX", "100");
  await redis("ZADD", KEYS.waitlistIndex, String(Math.floor((day1 + 1e10) / 1000)), oldField);
  await saveSignup(redis, { email: "hn@example.com", agents: 5, plan: "pro", attribution: { utm_source: "hn", utm_medium: "social", utm_campaign: "launch", referrer_host: "news.ycombinator.com", landing_path: "/" }, now: day2 });
  await saveSignup(redis, { email: "direct@example.com", agents: null, plan: "pro", attribution: null, now: day2 + 1000 });
  return { redis, day1, day2 };
}

test("admin waitlist: 401 without the admin cookie, and no data in the body", async () => {
  const { redis } = await seed();
  const h = createHandler({ redis: () => redis, env: ENV });
  for (const url of ["/api/waitlist", "/api/waitlist?format=csv"]) {
    const r = await call(h, { url });
    assert.equal(r.status, 401, url);
    assert.doesNotMatch(r.raw, /@|rows|hn/, "no emails, rows or sources");
    assert.equal(r.headers["cache-control"], "no-store");
  }
  const forged = await call(h, { headers: { cookie: `${cookie}x` } });
  assert.equal(forged.status, 401);
  const off = await call(createHandler({ redis: () => redis, env: { VERCEL_ENV: "production" } }), { headers: { cookie } });
  assert.equal(off.status, 401, "production with no password never opens");
});

test("admin waitlist: JSON rows newest first, with counts by day, source and plan", async () => {
  const { redis, day1, day2 } = await seed();
  const h = createHandler({ redis: () => redis, env: ENV });
  const r = await call(h, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.body.ok, true);
  assert.equal(r.body.total, 3);
  assert.deepEqual(r.body.rows.map((x) => x.email), ["direct@example.com", "hn@example.com", "old@example.com"]);
  assert.deepEqual(r.body.rows[1], {
    email: "hn@example.com",
    plan: "pro",
    agents: 5,
    ts: day2,
    last_ts: day2,
    count: 1,
    utm_source: "hn",
    utm_medium: "social",
    utm_campaign: "launch",
    referrer_host: "news.ycombinator.com",
    landing_path: "/",
  });
  assert.deepEqual(r.body.rows[2], {
    email: "old@example.com",
    plan: "free",
    agents: 2,
    ts: day1,
    last_ts: day1,
    count: 1,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    referrer_host: null,
    landing_path: null,
  }, "an old row reads with defaults");
  assert.deepEqual(r.body.by_day, [{ day: "2026-10-14", n: 1 }, { day: "2026-10-15", n: 2 }]);
  assert.deepEqual(r.body.by_source, [{ source: "direct", n: 2 }, { source: "hn", n: 1 }], "an empty source counts as direct");
  assert.deepEqual(r.body.by_plan, [{ plan: "pro", n: 2 }, { plan: "free", n: 1 }]);
});

test("admin waitlist: index members with no row, or a corrupt row, are skipped", async () => {
  const { redis } = await seed();
  await redis("ZADD", KEYS.waitlistIndex, "1", "a".repeat(64));
  await redis("SET", KEYS.waitlistEntry("b".repeat(64)), "{not-json");
  await redis("ZADD", KEYS.waitlistIndex, "1", "b".repeat(64));
  await redis("ZADD", KEYS.waitlistIndex, "1", "not-a-hash");
  const r = await call(createHandler({ redis: () => redis, env: ENV }), { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
});

test("admin waitlist: CSV has a header row, quotes commas and quotes, and downloads with no-store", async () => {
  const { redis } = await seed();
  const odd = "a,b\"c@example.com";
  const field = emailKey(odd);
  await redis("SET", KEYS.waitlistEntry(field), JSON.stringify({ email: odd, hash: field, agents: 1, plan: "dev", ts: Date.UTC(2026, 9, 15, 10), last_ts: Date.UTC(2026, 9, 15, 10), count: 1, attribution: null }));
  await redis("ZADD", KEYS.waitlistIndex, "1", field);
  const h = createHandler({ redis: () => redis, env: ENV, now: () => Date.UTC(2026, 9, 15, 23) });
  const r = await call(h, { url: "/api/waitlist?format=csv", headers: { cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/csv/);
  assert.equal(r.headers["content-disposition"], 'attachment; filename="logmem-waitlist-2026-10-15.csv"');
  assert.equal(r.headers["cache-control"], "no-store");
  const lines = r.raw.trim().split("\r\n");
  assert.equal(lines[0], "email,plan,agents,ts,last_ts,count,utm_source,utm_medium,utm_campaign,referrer_host,landing_path");
  assert.equal(lines.length, 5, "header plus 4 rows");
  assert.equal(lines[1], '"a,b""c@example.com",dev,1,2026-10-15T10:00:00.000Z,2026-10-15T10:00:00.000Z,1,,,,,');
  assert.ok(lines.some((l) => l.startsWith("hn@example.com,pro,5,")));
});

test("admin waitlist: csvCell quotes and defuses spreadsheet formulas", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(5), "5");
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("@x"), "'@x");
});

test("admin waitlist: only GET; 503 without a backend", async () => {
  const h = createHandler({ redis: () => createMemoryRedis(), env: ENV });
  assert.equal((await call(h, { method: "POST", headers: { cookie } })).status, 405);
  assert.equal((await call(createHandler({ redis: () => null, env: ENV }), { headers: { cookie } })).status, 503);
  const empty = await call(h, { headers: { cookie } });
  assert.deepEqual(empty.body, { ok: true, total: 0, rows: [], by_day: [], by_source: [], by_plan: [] });
});

test("memory-redis: MGET returns values in order with null for missing keys", async () => {
  const redis = createMemoryRedis();
  await redis("SET", "a", "1");
  await redis("SET", "c", "3");
  assert.deepEqual(await redis("MGET", "a", "b", "c"), ["1", null, "3"]);
});
