import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { createHandler, cronAuthorized, fleetTruthSpaces } from "../api/cron/fleet-truth.mjs";
import { lockKey } from "../src/fleet-truth/run.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";

const SECRET = "test-only-cron-secret-0123456789abcdef0123456789";
const ENV = { CRON_SECRET: SECRET, LOGMEM_FLEET_TRUTH_SPACES: "madez" };
const AUTH = { authorization: `Bearer ${SECRET}` };
const T_MIDDAY = Date.parse("2026-11-04T18:00:00.000Z"); // 13:00 ET
const T_TEN = Date.parse("2026-11-04T15:00:00.000Z"); // 10:00 ET
const quiet = () => {};

const call = async (handler, headers = {}, method = "GET") => {
  const res = mockRes();
  await handler(mockReq({ method, url: "/api/cron/fleet-truth", headers }), res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined, res };
};

test("fleet-truth cron auth: CRON_SECRET unset or short -> 503, nothing runs", async () => {
  const redis = createMemoryRedis();
  for (const env of [{}, { CRON_SECRET: "" }, { CRON_SECRET: "short" }]) {
    const h = createHandler({ env, resolveRedis: () => redis, sink: quiet });
    const r = await call(h, AUTH);
    assert.equal(r.status, 503);
    assert.equal(r.res.headers["cache-control"], "no-store");
  }
  assert.equal(redis._data.size, 0, "fail closed: no writes");
});

test("fleet-truth cron auth: missing or wrong header -> 401", async () => {
  const redis = createMemoryRedis();
  const h = createHandler({ env: ENV, resolveRedis: () => redis, sink: quiet });
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: SECRET }]) {
    const r = await call(h, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(r.body, { error: "unauthorized" });
  }
  assert.equal(cronAuthorized({ headers: AUTH }, SECRET), true);
  assert.equal(fleetTruthSpaces(ENV)[0], "madez");
});

test("fleet-truth cron: non-slot now skips without writing Now", async () => {
  const redis = createMemoryRedis();
  const h = createHandler({ env: ENV, resolveRedis: () => redis, now: () => T_TEN, sink: quiet });
  const r = await call(h, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].skipped, "not_a_slot");
  const store = createStore(redis, { space: "madez", compat: false });
  assert.equal(Object.keys((await store.getNow("channel", "fleet-truth")) || {}).length, 0);
});

test("fleet-truth cron: slot now writes board and checkup", async () => {
  const redis = createMemoryRedis();
  const h = createHandler({ env: ENV, resolveRedis: () => redis, now: () => T_MIDDAY, sink: quiet });
  const r = await call(h, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].ok, true);
  assert.match(r.body.results[0].trail, /midday$/);
  const store = createStore(redis, { space: "madez", compat: false });
  const now = await store.getNow("channel", "fleet-truth");
  assert.ok(now.board);
  const checkups = (await store.readLog("channel", "fleet-truth")).filter((e) => e.kind === "checkup");
  assert.equal(checkups.length, 1);
  assert.equal(checkups[0].by, "agent:fleet-truth");
});

test("fleet-truth cron: lock skip when lock held", async () => {
  const redis = createMemoryRedis();
  await redis("SET", lockKey("madez", "2026-11-04", "midday"), "held", "NX", "EX", "600");
  const h = createHandler({ env: ENV, resolveRedis: () => redis, now: () => T_MIDDAY, sink: quiet });
  const r = await call(h, AUTH);
  assert.equal(r.status, 200);
  assert.equal(r.body.results[0].skipped, "locked");
});
