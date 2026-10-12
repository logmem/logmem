// review-pr8.test.mjs — fixes for the PR #8 security review (decision
// integrity follow-up). One section per review item. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { checkAgentId, AGENT_ID_RE } from "../src/core/keys.mjs";
import { buildView } from "../src/http/view.mjs";
import inbox from "../api/inbox/[agent].mjs";
import { makeTrail, trailTs, trailNonce, NONCE_RE, ASK_ONLY } from "../src/core/tools.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function clock(start = 1791712800000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** Two agents in one space: atlas (a) and quill (q), both started. */
async function team({ compat = false, now } = {}) {
  const redis = createMemoryRedis();
  const mk = (sid) => createLogmem({ redis, space: "fieldnotes", surface: "codex", sessionId: sid, compat, ...(now ? { now } : {}) });
  const a = mk("atlas-s");
  const q = mk("quill-s");
  await sc(a, "logmem_start", { agent: "atlas" });
  await sc(q, "logmem_start", { agent: "quill" });
  return { redis, a, q, mk, store: createStore(redis, { space: "fieldnotes" }) };
}

function mockRes() {
  const r = { statusCode: 200, headers: {}, body: null };
  r.setHeader = (k, v) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (o) => ((r.body = o), r);
  r.end = () => r;
  return r;
}

// ─── Item 6: agent ids validated everywhere they enter ──────────────────
const BAD_IDS = ["", "-lead", ".hidden", "a b", "quill\n", "a/b", "ünïcode", "x".repeat(65), "evil<script>", "a*"];

test("item 6: checkAgentId accepts 1-64 of [A-Za-z0-9._-] and an agent: prefix; refuses the rest", () => {
  for (const ok of ["quill", "agent:quill", "claude-code", "grok_local", "v1.2", "A", "x".repeat(64)]) {
    assert.equal(checkAgentId(ok), ok.replace(/^agent:/, ""), ok);
  }
  for (const bad of BAD_IDS) assert.throws(() => checkAgentId(bad), (e) => e.code === "bad_agent_id", JSON.stringify(bad));
  assert.throws(() => checkAgentId(42), /must be a string/);
  assert.ok(AGENT_ID_RE.test("ok-id"));
});

test("item 6: native and compat tools refuse bad agent ids at every entry point and write nothing", async () => {
  const { redis, a } = await team({ compat: true });
  const before = new Set(redis._data.keys());
  for (const bad of ["a b", "x".repeat(65), "-x", "evil<script>"]) {
    const tries = [
      ["logmem_start", { agent: bad }],
      ["logmem_brief", { agent: bad }],
      ["logmem_handoff", { to: bad, summary: "s", create_agent: true }],
      ["logmem_note", { where: `agent:${bad}`, summary: "s" }],
      ["logmem_view", { ref: bad }],
      ["logmem_status", { agent: bad, now: { x: 1 } }],
      ["logmem_bio", { agent: bad, who: { x: 1 } }],
      ["logmem_follow", { action: "follow", ref: "channel:ops", agent: bad }],
      ["logmem_assign", { job: "j-bad", title: "t", owner: bad }],
      ["logmem_ask", { question: "q", action: "a", reversible: true, where: `agent:${bad}` }],
      ["acmi_profile", { namespace: "agent", id: bad, profile: "{}" }],
      ["acmi_signal", { namespace: "agent", id: bad, signals: "{}" }],
      ["acmi_event", { namespace: "agent", id: bad, source: "x", summary: "s" }],
      ["acmi_get", { namespace: "agent", id: bad }],
      ["acmi_spawn", { agentId: bad }],
      ["acmi_bootstrap", { agentId: bad }],
      ["acmi_active", { agentId: bad, action: "list" }],
      ["acmi_rollup_set", { agentId: bad, rollup: "{}" }],
    ];
    for (const [tool, args] of tries) {
      const r = await a.callTool(tool, args);
      assert.equal(r.isError, true, `${tool} must refuse ${JSON.stringify(bad)}`);
    }
  }
  const added = [...redis._data.keys()].filter((k) => !before.has(k) && !k.includes(":session:") && !k.endsWith(":atlas:log") && !k.endsWith(":atlas:shifts"));
  assert.deepEqual(added, [], "no refused call created keys");
});

test("item 6: a default agent with a bad id cannot auto-start a shift", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "fieldnotes", surface: "codex", sessionId: "s", defaultAgent: "bad id" });
  const r = await lm.callTool("logmem_brief", {});
  assert.equal(r.isError, true);
  assert.match(r.structuredContent.error, /agent must be 1-64 characters/);
});

test("item 6: /api/inbox and the agent view refuse bad agent ids with 400", async () => {
  const redis = createMemoryRedis();
  globalThis.__lmDevRedis = redis;
  try {
    const run = async (agent) => {
      const res = mockRes();
      await inbox({ method: "POST", url: `/api/inbox/x`, query: { agent }, headers: { host: "x", "x-logmem-rest-url": "memory://test", "x-logmem-rest-token": "t", "x-logmem-space": "acme" }, body: { summary: "hi" } }, res);
      return res;
    };
    assert.equal((await run("x".repeat(65))).statusCode, 400);
    assert.equal((await run("-lead")).statusCode, 400);
    assert.equal((await run("a.b")).statusCode, 201, "dots are fine");
  } finally {
    delete globalThis.__lmDevRedis;
  }
  await assert.rejects(() => buildView(redis, "acme", "agent", { id: "a b" }), (e) => e.code === "bad_agent_id");
});

// ─── Item 5: every trail carries a nonce ────────────────────────────────
test("item 5: generated trails end in a 96-bit nonce; two asks in the same ms get different trails", async () => {
  const now = clock();
  const { q, a } = await team({ now });
  const t1 = await sc(q, "logmem_ask", { question: "Send?", action: "send", reversible: false });
  const t2 = await sc(q, "logmem_ask", { question: "Send?", action: "send", reversible: false });
  assert.notEqual(t1.trail, t2.trail, "same ms, same where, still distinct");
  for (const t of [t1.trail, t2.trail]) assert.match(t, /^approvalQuill-1791712800000-[0-9a-f]{24}$/);
  assert.equal(trailTs(t1.trail), 1791712800000);
  assert.equal(trailTs("approvalQuill-1791712800000"), 1791712800000, "older trails still parse");
  assert.equal(makeTrail("x", "y", 5).split("-").pop().length, 24);
  assert.match(trailNonce(), NONCE_RE);

  const ho = await sc(a, "logmem_handoff", { to: "quill", summary: "s" });
  assert.match(ho.trail, /-[0-9a-f]{24}$/);
  const started = (await sc(a, "logmem_view", { ref: "agent:atlas", limit: 50 })).log.find((e) => e.kind === "started");
  assert.match(started.shift, /^atlasShift-\d+-[0-9a-f]{24}$/, "shift ids carry a nonce too");
});

test("item 5: an ask can't be replayed under a chosen trail (approval only via logmem_ask)", async () => {
  const { q, store } = await team({ compat: true });
  const ask = await sc(q, "logmem_ask", { question: "Old ask", action: "x", reversible: true });
  const tries = [
    ["logmem_note", { where: "agent:quill", kind: "approval", trail: ask.trail, summary: "replay" }],
    ["logmem_note", { where: "job:j", kind: "decision-request", trail: ask.trail, summary: "replay" }],
    ["logmem_update", { job: "j", kind: "approval", summary: "replay" }],
    ["acmi_event", { namespace: "agent", id: "quill", source: "agent:quill", kind: "decision-request", correlationId: ask.trail, summary: "replay" }],
    ["acmi_work_event", { id: "j", source: "agent:quill", kind: "approval", summary: "replay" }],
  ];
  for (const [tool, args] of tries) {
    const r = await q.callTool(tool, args);
    assert.equal(r.isError, true, tool);
    assert.equal(r.structuredContent.error, ASK_ONLY);
  }
  const asks = (await store.readLog("agent", "quill")).filter((e) => e.kind === "approval");
  assert.equal(asks.length, 1, "only the real ask exists");
});
