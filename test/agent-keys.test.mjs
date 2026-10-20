// Per-agent LogMem keys (Mikey, Oct 19): one key per agent, bound to one space
// and one agent id, for agents with no MCP client (Muse's acmi-exec pattern).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, mockRes, mockReq } from "./oauth-helpers.mjs";
import { __setRedisForTests } from "../api/oauth/_lib/storage.mjs";
import { createAgentKey, listAgentKeys, revokeAgentKey, lookupAgentKey, AgentKeyError } from "../src/http/agent-keys.mjs";
import { resolveAuth } from "../src/http/auth.mjs";
import { createLogmem } from "../src/server.mjs";
import { issueCookie } from "../src/http/admin-auth.mjs";
import { createHandler } from "../api/agent-keys.mjs";

const ENV = { VERCEL_ENV: "production", LOGMEM_SPACES: "madez", LOGMEM_REST_URL: "https://bridge.example/exec", LOGMEM_REST_TOKEN: "t", LOGMEM_ADMIN_PASSWORD: "correct horse" };

test("agent keys: create, look up, list without the key, revoke", async () => {
  const redis = oauthRedis();
  const k = await createAgentKey({ space: "madez", agent: "muse", label: "Muse vault" }, { env: ENV, redis });
  assert.match(k.key, /^lmk_[A-Za-z0-9_-]{43}$/);
  assert.match(k.id, /^ak_[0-9a-f]{12}$/);
  assert.deepEqual(await lookupAgentKey(k.key, { redis }), { id: k.id, space: "madez", agent: "muse" });

  const list = await listAgentKeys({ redis });
  assert.equal(list.length, 1);
  assert.equal(list[0].agent, "muse");
  assert.ok(!JSON.stringify(list).includes(k.key), "the list never carries the key");
  assert.ok(redis.data.size >= 3, "records were written");
  const stored = JSON.stringify([...redis.data.entries()]);
  assert.ok(!stored.includes(k.key), "the key is stored only as a hash");

  assert.equal(await revokeAgentKey(k.id, { redis }), true);
  assert.equal(await lookupAgentKey(k.key, { redis }), null, "revoked keys stop working");
  assert.deepEqual(await listAgentKeys({ redis }), []);
  assert.equal(await revokeAgentKey(k.id, { redis }), false);
});

test("agent keys: only the deploy's spaces and valid agent ids; junk bearers are not looked up", async () => {
  const redis = oauthRedis();
  await assert.rejects(() => createAgentKey({ space: "other", agent: "muse" }, { env: ENV, redis }), AgentKeyError);
  await assert.rejects(() => createAgentKey({ space: "madez", agent: "not an id!" }, { env: ENV, redis }), AgentKeyError);
  await assert.rejects(() => revokeAgentKey("../x", { redis }), AgentKeyError);
  const calls = [];
  const spy = async (...c) => { calls.push(c); return null; };
  assert.equal(await lookupAgentKey("some-oauth-token", { redis: spy }), null);
  assert.equal(await lookupAgentKey("lmk_short", { redis: spy }), null);
  assert.equal(calls.length, 0);
});

test("agent keys: a key authenticates to the server backend, pinned to its space and agent", async () => {
  const redis = oauthRedis();
  __setRedisForTests(redis);
  try {
    const k = await createAgentKey({ space: "madez", agent: "muse" }, { env: ENV, redis });
    const req = { headers: { authorization: `Bearer ${k.key}`, "x-logmem-space": "fieldnotes" } };
    const auth = await resolveAuth(req, {}, ENV);
    assert.equal(auth.source, "agent-key");
    assert.equal(auth.space, "madez", "the key's space wins over the header");
    assert.equal(auth.pinned, true);
    assert.equal(auth.agent, "muse");
    assert.equal(auth.backend.url, ENV.LOGMEM_REST_URL);

    // A space the deploy no longer serves: unauthenticated.
    assert.equal((await resolveAuth(req, {}, { ...ENV, LOGMEM_SPACES: "fieldnotes" })).source, "none");
    // Revoked: unauthenticated.
    await revokeAgentKey(k.id, { redis });
    assert.equal((await resolveAuth(req, {}, ENV)).source, "none");
  } finally {
    __setRedisForTests(null);
  }
});

test("agent keys: a locked connection writes only as its own agent", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "k1", surface: "http", defaultAgent: "muse", lockedAgent: "muse" });
  const other = await lm.callTool("logmem_start", { agent: "bentley-main" });
  assert.equal(other.isError, true, "starting as another agent is refused");
  assert.match(JSON.stringify(other.structuredContent), /bound to agent muse/);

  const note = (await lm.callTool("logmem_note", { where: "channel:ops", summary: "hello" })).structuredContent;
  assert.equal(note.ok, true);
  assert.equal(note.entry.by, "agent:muse", "auto-start uses the key's agent");
  assert.equal((await lm.callTool("logmem_start", { agent: "muse" })).isError, undefined);
});

const cookie = issueCookie(ENV).split(";")[0];
const call = async (h, { method = "GET", body, headers = {} } = {}) => {
  const req = mockReq({ method, url: "/api/agent-keys", body, headers: { host: "logmem.si", ...headers } });
  const res = mockRes();
  await h(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body ? JSON.parse(res.body) : undefined };
};

test("agent keys API: admin only, intent header on writes, key shown once", async () => {
  const redis = oauthRedis();
  const h = createHandler({ env: ENV, redis: () => redis });
  assert.equal((await call(h)).status, 401);
  assert.equal((await call(h, { method: "POST", body: { space: "madez", agent: "muse" } })).status, 401);

  const auth = { cookie };
  assert.equal((await call(h, { method: "POST", body: { space: "madez", agent: "muse" }, headers: auth })).status, 403, "no intent header");
  assert.equal((await call(h, { method: "POST", body: { space: "madez", agent: "muse" }, headers: { ...auth, "x-logmem-intent": "agent-keys", origin: "https://evil.example" } })).status, 403, "cross-site");

  const w = { ...auth, "x-logmem-intent": "agent-keys", origin: "https://logmem.si" };
  const made = await call(h, { method: "POST", body: { space: "madez", agent: "muse", label: "Muse vault" }, headers: w });
  assert.equal(made.status, 201);
  assert.match(made.body.key, /^lmk_/);
  assert.equal(made.headers["cache-control"], "no-store");

  const listed = await call(h, { headers: auth });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.spaces, ["madez"]);
  assert.equal(listed.body.keys.length, 1);
  assert.ok(!JSON.stringify(listed.body).includes(made.body.key), "GET never returns the key");

  assert.equal((await call(h, { method: "POST", body: { space: "nope", agent: "muse" }, headers: w })).status, 400);
  const rv = await call(h, { method: "POST", body: { action: "revoke", id: made.body.id }, headers: w });
  assert.deepEqual(rv.body, { revoked: true });
  assert.equal((await call(h, { headers: auth })).body.keys.length, 0);
});

// Codex review of PR #58 (98e5a62), Oct 19.
import { scopedSessionId } from "../api/mcp.mjs";
import { createStore } from "../src/core/store.mjs";
import { createShifts } from "../src/core/session.mjs";
import inboxHandler from "../api/inbox/[agent].mjs";

test("agent keys: a locked connection cannot recap another agent's shift on a shared session", async () => {
  const redis = createMemoryRedis();
  const atlas = createLogmem({ redis, space: "madez", sessionId: "shared", surface: "http" });
  await atlas.callTool("logmem_start", { agent: "atlas" });
  const muse = createLogmem({ redis, space: "madez", sessionId: "shared", surface: "http", defaultAgent: "muse", lockedAgent: "muse" });
  await muse.callTool("logmem_recap", { notes: "written as atlas?" });
  const log = (await redis("ZRANGE", "lm:madez:agent:atlas:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(!log.some((e) => e.kind === "recap"), "nothing is ever written as atlas");

  // The race codex found: atlas takes the shared session between Muse's touch and recap.
  const store = createStore(redis, { space: "madez" });
  const locked = createShifts(store, { sessionId: "race", surface: "http", lockedAgent: "muse" });
  await locked.touch("logmem_note");
  await createShifts(store, { sessionId: "race", surface: "http" }).start("atlas");
  await assert.rejects(() => locked.recap({ notes: "as atlas?" }), /no open shift for muse/);
  assert.equal(await locked.current(), null, "another agent's shift is not shown to a locked connection");
  const after = (await redis("ZRANGE", "lm:madez:agent:atlas:log", "0", "-1")).map((x) => JSON.parse(x));
  assert.ok(!after.some((e) => e.kind === "recap"), "still nothing written as atlas");
});

test("agent keys: an agent key's session id is scoped to the key", () => {
  assert.equal(scopedSessionId("http.abc", { source: "agent-key", keyId: "ak_0123456789ab" }), "http.abc~ak_0123456789ab");
  assert.equal(scopedSessionId("http.abc", { source: "oauth" }), "http.abc");
  assert.notEqual(scopedSessionId("s", { source: "agent-key", keyId: "ak_aaaaaaaaaaaa" }), scopedSessionId("s", { source: "agent-key", keyId: "ak_bbbbbbbbbbbb" }));
});

test("agent keys: the inbox refuses agent keys (it records a human writer)", async () => {
  const redis = oauthRedis();
  __setRedisForTests(redis);
  const saved = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const k = await createAgentKey({ space: "madez", agent: "muse" }, { env: ENV, redis });
    const req = mockReq({ method: "POST", url: "/api/inbox/atlas", body: { summary: "hi" }, headers: { authorization: `Bearer ${k.key}` } });
    req.query = { agent: "atlas" };
    const res = mockRes();
    await inboxHandler(req, res);
    assert.equal(res.statusCode, 403);
  } finally {
    for (const key of Object.keys(ENV)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    __setRedisForTests(null);
  }
});

// Codex re-review of PR #58 on main (f232800): a long session id must not lose the key scope.
import { sessionKeyPart } from "../src/core/session.mjs";

test("agent keys: long session ids keep their key scope in the stored session", async () => {
  const redis = createMemoryRedis();
  const store = createStore(redis, { space: "madez" });
  const long = `${"x".repeat(77)}`;
  const museSid = scopedSessionId(long, { source: "agent-key", keyId: "ak_aaaaaaaaaaaa" });
  const atlasSid = scopedSessionId(long, { source: "agent-key", keyId: "ak_bbbbbbbbbbbb" });
  assert.notEqual(sessionKeyPart(museSid), sessionKeyPart(atlasSid), "different keys, different stored sessions");
  assert.ok(sessionKeyPart(museSid).length <= 60);
  const muse = createShifts(store, { sessionId: museSid, surface: "http", lockedAgent: "muse" });
  await muse.start("muse");
  await createShifts(store, { sessionId: atlasSid, surface: "http", lockedAgent: "atlas" }).start("atlas");
  assert.equal((await muse.current())?.agent, "muse", "atlas did not replace muse's session");
  assert.equal(sessionKeyPart("claude-code.abc"), "claude-code-abc", "short ids keep their old key");
});
