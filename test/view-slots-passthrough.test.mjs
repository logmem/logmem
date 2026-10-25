// view-slots-passthrough.test.mjs — the slots view's date param must survive the HTTP route.
//
// The slots view supports `params.date` to read another day, but the /api/view route
// never forwarded it, so the page always showed today and there was no way to look
// back at a day. This pins the passthrough and the per-agent slot states the page
// renders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import handler from "../api/view.mjs";

const SPACE = "fieldnotes";
const OTHER_DAY = "2026-01-15";

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
    query: { space: SPACE, what: "slots", ...query },
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

const push = (redis, agent, date, slot, outcome) =>
  redis("RPUSH", `lm:${SPACE}:sync:slot:${agent}:${date}:${slot}`, JSON.stringify({ outcome }));

test("slots view: the date param survives the route and each agent's runs are returned", async () => {
  const redis = createMemoryRedis();
  await redis("SADD", `lm:${SPACE}:agent:list`, "quill");
  await push(redis, "quill", OTHER_DAY, "morning", "pass");
  await push(redis, "quill", OTHER_DAY, "midday", "failed");

  // Without a date the view chooses today; with a date it reads that day.
  const def = await call(redis);
  assert.equal(def.status, 200, "handler answers 200");
  assert.ok(def.data.date, "a default date is chosen");
  const today = def.data.agents.find((a) => a.agent === "quill");
  assert.ok(today, "the roster agent is listed");
  assert.deepEqual(Object.keys(today.slots).sort(), ["closeout", "midday", "morning"], "three runs a day");

  const onOther = await call(redis, { date: OTHER_DAY });
  assert.equal(onOther.data.date, OTHER_DAY, "the date param reaches the view");
  const quill = onOther.data.agents.find((a) => a.agent === "quill");
  assert.equal(quill.slots.morning.state, "pass", "a receipt is a pass");
  assert.equal(quill.slots.midday.state, "failed", "the last outcome wins");
  assert.equal(quill.slots.closeout.state, "pending", "an empty slot that has not passed its window is pending");
});
