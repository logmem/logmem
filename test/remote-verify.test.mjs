// answered-means-answered: a local agent with no signing key verifies web decisions
// through the trusted server (POST /api/verify-decisions), and nothing else counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { createStore } from "../src/core/store.mjs";
import { writeDecision, remoteVerified, signDecision, REMOTE_VERIFY_MAX } from "../src/core/tools.mjs";
import verifyHandler from "../api/verify-decisions.mjs";

const SECRET = "test-only-decide-key-0123456789abcdef";
const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

/** A fetch that calls the real handler with the server's key, and records calls. */
function serverFetch({ secret = SECRET, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (fail) throw new Error("network down");
    let status = 0, body;
    const res = { status(s) { status = s; return this; }, setHeader() { return this; }, json(b) { body = b; return this; } };
    await verifyHandler({ method: "POST", body: JSON.parse(init.body) }, res, { env: { LOGMEM_DECIDE_SECRET: secret } });
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

async function setup(agentOpts = {}) {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "fleet" });
  const server = createLogmem({ workRules: "warn", redis, space: "fleet", sessionId: "srv", surface: "web", defaultAgent: "quill", decideSecret: SECRET });
  await sc(server, "logmem_assign", { job: "issue-14", title: "Issue 14" });
  const ask = await sc(server, "logmem_ask", { question: "Send issue 14?", action: "POST send", reversible: false, where: "job:issue-14" });
  const out = await writeDecision(store, ask.trail, { verdict: "approve", note: "Go", by: "human:mikey", confirm: true, secret: SECRET });
  // A local agent: no signing key.
  const local = createLogmem({ workRules: "warn", redis, space: "fleet", sessionId: "loc", surface: "claude-code", defaultAgent: "quill", decideSecret: null, ...agentOpts });
  return { redis, store, ask, decision: out.entry, local };
}

test("remote verify: with no key and no verify URL, a web decision stays pending and unverified (today's behavior)", async () => {
  const { ask, local } = await setup();
  const b = await sc(local, "logmem_brief", {});
  assert.deepEqual(b.pending_asks.map((x) => x.trail), [ask.trail]);
  assert.equal(b.answered_asks.length, 0);
});

test("remote verify: the trusted server verifies it, so the Brief shows it answered and verified", async () => {
  const srv = serverFetch();
  const { ask, local } = await setup({ verifyUrl: "https://logmem.test/api/verify-decisions", fetchImpl: srv.fetchImpl });
  const b = await sc(local, "logmem_brief", {});
  assert.equal(b.pending_asks.length, 0, JSON.stringify(b.pending_asks));
  assert.deepEqual(b.answered_asks.map((x) => [x.trail, x.verdict, x.decided_by]), [[ask.trail, "approve", "human:mikey"]]);
  assert.ok(!b.log.some((e) => e.kind === "decided" && e.unverified), "no decided row in the log reads unverified");
  assert.ok(srv.calls.length >= 1);
  assert.ok(!JSON.stringify(srv.calls).includes(SECRET), "the key never leaves the server");
});

test("remote verify: a forged decision or a server with another key never counts", async () => {
  const wrongKey = serverFetch({ secret: "another-key-0123456789abcdef0123456789" });
  const a = await setup({ verifyUrl: "https://x/api/verify-decisions", fetchImpl: wrongKey.fetchImpl });
  assert.equal((await sc(a.local, "logmem_brief", {})).answered_asks.length, 0);

  const srv = serverFetch();
  const { ask, decision } = await setup();
  // A valid sig moved onto an altered decision (reject instead of approve).
  const forged = { ...decision, payload: { ...decision.payload, verdict: "reject" } };
  const ok = await remoteVerified([decision, forged], { space: "fleet", url: "https://x", fetchImpl: srv.fetchImpl });
  assert.equal(ok.size, 1, "only the real one");
  // Another space: the same decision does not verify there.
  assert.equal((await remoteVerified([decision], { space: "other", url: "https://x", fetchImpl: srv.fetchImpl })).size, 0);
  assert.ok(ask.trail);
});

test("remote verify: a network failure fails closed and the Brief still works", async () => {
  const down = serverFetch({ fail: true });
  const { ask, local } = await setup({ verifyUrl: "https://x/api/verify-decisions", fetchImpl: down.fetchImpl });
  const b = await sc(local, "logmem_brief", {});
  assert.equal(b.ok, true);
  assert.deepEqual(b.pending_asks.map((x) => x.trail), [ask.trail]);
});

test("verify endpoint: POST only, 503 without a key, bounded input", async () => {
  const call = async (req, env = { LOGMEM_DECIDE_SECRET: SECRET }) => {
    let status = 0, body;
    const res = { status(s) { status = s; return this; }, setHeader() { return this; }, json(b) { body = b; return this; } };
    await verifyHandler(req, res, { env });
    return { status, body };
  };
  assert.equal((await call({ method: "GET" })).status, 405);
  assert.equal((await call({ method: "POST", body: { space: "fleet", decisions: [] } }, {})).status, 503);
  assert.equal((await call({ method: "POST", body: { decisions: [] } })).status, 400);
  assert.equal((await call({ method: "POST", body: { space: "fleet", decisions: Array(201).fill({}) } })).status, 400);
  const ok = await call({ method: "POST", body: { space: "fleet", decisions: [{ origin: "x", by: "human:a", ts: 1, verdict: "approve", ask_hash: "0".repeat(64), sig: "f".repeat(64) }, null, 5] } });
  assert.deepEqual(ok, { status: 200, body: { valid: [] } });
});

// Codex on PR 102: decisions past the first 200 were never verified.
test("remote verify: 450 decisions go in batches of 200 and all verify; a failed batch fails closed alone", async () => {
  const signed = (i) => {
    const f = { space: "fleet", origin: `ask-${i}`, ask_hash: `h${i}`, verdict: "approve", note: null, by: "human:mikey", ts: 1792600000000 + i };
    return { kind: "decided", origin: f.origin, by: f.by, ts: f.ts, payload: { ask_hash: f.ask_hash, verdict: f.verdict, note: f.note, sig: signDecision(f, SECRET) } };
  };
  const entries = Array.from({ length: 450 }, (_, i) => signed(i));
  const { fetchImpl, calls } = serverFetch();
  const ok = await remoteVerified(entries, { space: "fleet", url: "https://logmem.test/api/verify-decisions", fetchImpl });
  assert.equal(ok.size, 450, "every decision verifies, not only the first 200");
  assert.deepEqual(calls.map((c) => c.decisions.length), [200, 200, 50]);
  assert.ok(calls.every((c) => c.decisions.length <= REMOTE_VERIFY_MAX));

  // The second batch fails: only its 200 stay unverified.
  let n = 0;
  const flaky = async (url, init) => (++n === 2 ? Promise.reject(new Error("network down")) : fetchImpl(url, init));
  const part = await remoteVerified(entries, { space: "fleet", url: "https://logmem.test/api/verify-decisions", fetchImpl: flaky });
  assert.equal(part.size, 250);
});
