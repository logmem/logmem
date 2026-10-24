// view-coord-passthrough.test.mjs — the audit view's queue params must survive the HTTP route.
//
// The coordination queue (auditView) supports recipient, type, plan, overdue, cursor and
// limit. The route used to forward only id/q/where/trail/person, so every one of those
// filters and the paging were unreachable from the web app: the queue rendered as one
// unfiltered page with no way to page. This pins the passthrough.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import { createCoordItem, COORD_DEADLINE_MS } from "../src/core/coord.mjs";
import handler from "../api/view.mjs";

const SPACE = "fieldnotes";

/** Two open handoffs: "one" is long overdue, "two" is fresh. */
async function seed() {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: SPACE });
  await createCoordItem(store, {
    space: SPACE, type: "handoff", requestTrail: "trail-1", from: "agent:alpha",
    to: "agent:beta", where: "job:j1", summary: "one", createdAt: Date.now() - 3 * COORD_DEADLINE_MS,
  });
  await createCoordItem(store, {
    space: SPACE, type: "handoff", requestTrail: "trail-2", from: "agent:gamma",
    to: "agent:delta", where: "job:j2", summary: "two", createdAt: Date.now(),
  });
  return redis;
}

/** Call the real Vercel handler against an in-process Redis. */
async function call(redis, query = {}) {
  const saved = {
    url: process.env.LOGMEM_REST_URL, token: process.env.LOGMEM_REST_TOKEN,
    spaces: process.env.LOGMEM_VIEW_SPACES, dev: globalThis.__lmDevRedis,
  };
  process.env.LOGMEM_REST_URL = "memory://test";
  process.env.LOGMEM_REST_TOKEN = "test";
  process.env.LOGMEM_VIEW_SPACES = SPACE;
  globalThis.__lmDevRedis = redis;
  const req = {
    method: "GET",
    url: "/api/view",
    query: { space: SPACE, what: "audit", ...query },
    headers: { host: "logmem.test" },
  };
  let status = 200, body = "";
  const res = {
    status(n) { status = n; return this; },
    setHeader() { return this; },
    json(o) { body = JSON.stringify(o); return this; },
    send(o) { body = typeof o === "string" ? o : JSON.stringify(o); return this; },
    end(o) { if (o !== undefined) body = typeof o === "string" ? o : JSON.stringify(o); return this; },
  };
  try {
    await handler(req, res);
    return { status, data: body ? JSON.parse(body) : undefined };
  } finally {
    for (const [k, v] of Object.entries({
      LOGMEM_REST_URL: saved.url, LOGMEM_REST_TOKEN: saved.token, LOGMEM_VIEW_SPACES: saved.spaces,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (saved.dev === undefined) delete globalThis.__lmDevRedis; else globalThis.__lmDevRedis = saved.dev;
  }
}

test("audit view: the route forwards the queue filters and paging", async () => {
  const redis = await seed();

  const all = await call(redis);
  assert.equal(all.status, 200, "handler answers 200");
  assert.equal(all.data.pending.total, 2, "both open items are listed");
  assert.equal(all.data.pending.items[0].summary, "one", "most overdue sorts first");

  const byRecipient = await call(redis, { recipient: "delta" });
  assert.equal(byRecipient.data.pending.total, 1, "recipient reaches the view");
  assert.equal(byRecipient.data.pending.items[0].summary, "two");

  const byType = await call(redis, { type: "seat" });
  assert.equal(byType.data.pending.total, 0, "type reaches the view");

  const overdueOnly = await call(redis, { overdue: "true" });
  assert.equal(overdueOnly.data.pending.total, 1, "overdue=true reaches the view");
  assert.equal(overdueOnly.data.pending.items[0].summary, "one");

  const firstPage = await call(redis, { limit: "1" });
  assert.equal(firstPage.data.pending.items.length, 1, "limit reaches the view");
  assert.equal(firstPage.data.pending.cursor, "1", "a next cursor is exposed");

  const secondPage = await call(redis, { limit: "1", cursor: "1" });
  assert.equal(secondPage.data.pending.items[0].summary, "two", "cursor reaches the view");
  assert.equal(secondPage.data.pending.cursor, null, "the last page has no next cursor");

  // Counts and coverage ride along, and the daily scorecard is still present.
  assert.equal(all.data.pending.counts.handoffs, 2);
  assert.equal(all.data.pending.counts.overdue, 1);
  assert.ok(all.data.coverage, "coverage is reported");
  assert.ok(all.data.days !== undefined, "scorecard history is retained alongside the queue");
});
