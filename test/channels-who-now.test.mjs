// channels Who/Now — the channels view carries the selected channel's profile
// and current state, read only. Spec: 2026-11-06-channels-view-who-now-spec-stub.md.
//
// Three shapes pin the contract: a channel that has both returns both, a
// channel that has neither returns null for both with 200, and an unknown id
// keeps the empty shape it had before this feature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createStore } from "../src/core/store.mjs";
import handler from "../api/view.mjs";

const SPACE = "fieldnotes";

async function seed() {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: SPACE });
  // A channel with Who and Now, plus one log entry so it appears in the list.
  await store.setWho("channel", "fleet-truth", { description: "Ground truth board", owner: "agent:grok" });
  await store.setNow("channel", "fleet-truth", { doing: "seeding", blocked: false });
  await store.append("channel", "fleet-truth", {
    kind: "memo", summary: "seed note", by: "agent:grok", trail: "t-1", shift: "s-1",
  });
  // A channel with neither slot, only a log entry.
  await store.append("channel", "quiet", {
    kind: "memo", summary: "just chat", by: "agent:muse", trail: "t-2", shift: "s-2",
  });
  return redis;
}

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
    query: { space: SPACE, what: "channels", ...query },
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

test("channels view: the selected channel returns its Who and Now beside the log", async () => {
  const redis = await seed();
  const r = await call(redis, { id: "fleet-truth" });
  assert.equal(r.status, 200, "handler answers 200");
  assert.equal(r.data.selected, "fleet-truth");
  assert.deepEqual(r.data.who, { description: "Ground truth board", owner: "agent:grok" }, "Who rides on the reply");
  assert.deepEqual(r.data.now, { doing: "seeding", blocked: false }, "Now rides on the reply");
  assert.equal(r.data.log.length, 1, "the log is unchanged");
  assert.ok(Array.isArray(r.data.channels) && r.data.channels.length === 2, "the list is unchanged");
});

test("channels view: a channel with neither slot returns null for both, still 200", async () => {
  const redis = await seed();
  const r = await call(redis, { id: "quiet" });
  assert.equal(r.status, 200, "handler answers 200");
  assert.equal(r.data.selected, "quiet");
  assert.equal(r.data.who, null, "missing Who is null, not an error");
  assert.equal(r.data.now, null, "missing Now is null, not an empty object");
  assert.equal(r.data.log.length, 1, "the log still ships");
});

test("channels view: an unknown id keeps the empty shape and never reads another space", async () => {
  const redis = await seed();
  const r = await call(redis, { id: "no-such-channel" });
  assert.equal(r.status, 200, "handler answers 200");
  assert.equal(r.data.selected, "no-such-channel");
  assert.equal(r.data.who, null, "unknown id: Who is null");
  assert.equal(r.data.now, null, "unknown id: Now is null");
  assert.deepEqual(r.data.log, [], "unknown id: empty log, as before");
  assert.ok(Array.isArray(r.data.channels), "the list still ships");
  // Same-space scoping: an empty store has nothing to leak.
  const empty = await call(createMemoryRedis(), { id: "fleet-truth" });
  assert.equal(empty.status, 200, "an empty store still answers 200");
  assert.equal(empty.data.who, null, "an empty store has no Who to leak");
  assert.equal(empty.data.now, null, "an empty store has no Now to leak");
});
