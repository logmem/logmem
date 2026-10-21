// job dist-bare-start: a bare logmem start uses the agent set at connect; the first start welcomes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { NO_BOUND_AGENT } from "../src/core/tools.mjs";

const call = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;
const lmFor = (redis, opts = {}) => createLogmem({ redis, space: "fleet", sessionId: opts.session || "s1", surface: "gemini-mac", ...opts });

test("bare start uses LOGMEM_AGENT (defaultAgent)", async () => {
  const lm = lmFor(createMemoryRedis(), { defaultAgent: "gemini-app" });
  const r = await call(lm, "logmem_start", {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.started.agent, "gemini-app");
  assert.equal(r.brief.agent, "gemini-app");
});

test("bare start uses the locked agent (agent key, managed sign-in)", async () => {
  const lm = lmFor(createMemoryRedis(), { defaultAgent: "muse", lockedAgent: "muse" });
  const r = await call(lm, "logmem_start", { agent: "" });
  assert.equal(r.started.agent, "muse");
});

test("a typed name still overrides the bound agent, unless the connection is locked", async () => {
  const redis = createMemoryRedis();
  const open = await call(lmFor(redis, { defaultAgent: "gemini-app" }), "logmem_start", { agent: "quill" });
  assert.equal(open.started.agent, "quill");
  const locked = await call(lmFor(redis, { session: "s2", defaultAgent: "muse", lockedAgent: "muse" }), "logmem_start", { agent: "quill" });
  assert.equal(locked.ok, false);
});

test("bare start with nothing bound fails with the fix, and never guesses from the surface", async () => {
  const r = await call(lmFor(createMemoryRedis()), "logmem_start", {});
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_BOUND_AGENT);
});

test("the first start ever carries welcome; later starts do not", async () => {
  const redis = createMemoryRedis();
  const first = await call(lmFor(redis, { defaultAgent: "gemini-app" }), "logmem_start", {});
  assert.ok(first.welcome, "first start has welcome");
  assert.equal(first.welcome.agent, "gemini-app");
  assert.equal(first.welcome.habits.length, 3);
  assert.deepEqual(first.welcome.habits.map((h) => h.example.tool), ["logmem_brief", "logmem_note", "logmem_recap"]);
  await call(lmFor(redis, { defaultAgent: "gemini-app" }), "logmem_recap", { notes: "done" });
  const again = await call(lmFor(redis, { session: "s3", defaultAgent: "gemini-app" }), "logmem_start", {});
  assert.equal(again.ok, true);
  assert.equal(again.welcome, undefined);
});

test("the welcome examples are valid calls", async () => {
  const redis = createMemoryRedis();
  const lm = lmFor(redis, { defaultAgent: "gemini-app" });
  const { welcome } = await call(lm, "logmem_start", {});
  for (const h of welcome.habits) {
    const r = await call(lm, h.example.tool, h.example.args);
    assert.equal(r.ok, true, `${h.example.tool}: ${JSON.stringify(r).slice(0, 200)}`);
  }
});
