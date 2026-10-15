// test/keymaster-apply.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyApproved, revoke } from "../cloud/keymaster/apply.mjs";
import { createInfisical } from "../cloud/keymaster/infisical.mjs";
import { createStore } from "../src/core/store.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";

const NOW = Date.parse("2026-10-15T00:00:00Z");
const ask = { trail: "askSecret-1", verdict: "approve", payload: { secret: "/shared/openai/OPENAI_API_KEY", for: "agent-codex", ttl: "30d" } };
function fakeInf() {
  const calls = [];
  return { calls, listIdentityGrants: async () => ({ ok: true, grants: [] }), identityIdFor: async () => "i1", addTemporaryGrant: async (a) => { calls.push(["add", a]); return { ok: true, grantId: "g1" }; }, revokeGrant: async (a) => { calls.push(["revoke", a]); return { ok: true }; } };
}

test("apply: approved ask grants once and logs refs only", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  assert.deepEqual(await applyApproved({ store, inf, token: "t", ask, now: NOW }), { ok: true, applied: true });
  const log = await store.readLog("job", "secrets");
  assert.equal(log.length, 1);
  assert.equal(log[0].payload.ask_trail, "askSecret-1");
  assert.equal(log[0].payload.secret_ref, "/shared/openai/OPENAI_API_KEY");
  assert.ok(!JSON.stringify(log).match(/grantId|identityId/));
});

test("apply: idempotent", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  await applyApproved({ store, inf, token: "t", ask, now: NOW });
  assert.deepEqual(await applyApproved({ store, inf, token: "t", ask, now: NOW + 1 }), { ok: true, applied: false });
  assert.equal(inf.calls.filter((c) => c[0] === "add").length, 1);
});

test("apply: rejected or invalid asks do nothing", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  assert.equal((await applyApproved({ store, inf, token: "t", ask: { ...ask, verdict: "reject" }, now: NOW })).applied, false);
  assert.equal((await applyApproved({ store, inf, token: "t", ask: { ...ask, payload: { ...ask.payload, for: "agent-keymaster" } }, now: NOW })).ok, false);
  assert.equal(inf.calls.length, 0);
});

test("apply: an unknown identity logs problem and grants nothing", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = { ...fakeInf(), identityIdFor: async () => null };
  const r = await applyApproved({ store, inf, token: "t", ask, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(inf.calls.length, 0);
  assert.equal((await store.readLog("job", "secrets"))[0].kind, "problem");
});

test("apply: a failed grant logs problem and reports not ok", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = { ...fakeInf(), addTemporaryGrant: async () => ({ ok: false, error: "infisical POST /x returned 500" }) };
  const r = await applyApproved({ store, inf, token: "t", ask, now: NOW });
  assert.equal(r.ok, false);
  assert.equal((await store.readLog("job", "secrets"))[0].kind, "problem");
});

test("apply: a failed grant can be retried (the ask stays open)", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" });
  const bad = { ...fakeInf(), addTemporaryGrant: async () => ({ ok: false, error: "x" }) };
  await applyApproved({ store, inf: bad, token: "t", ask, now: NOW });
  const good = fakeInf();
  assert.deepEqual(await applyApproved({ store, inf: good, token: "t", ask, now: NOW + 1 }), { ok: true, applied: true });
});

test("revoke: runs without an ask, passes grantId and identityId, and logs it", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = fakeInf();
  const r = await revoke({ store, inf, token: "t", grant: { identity: "agent-codex", identityId: "i1", path: "/shared/openai", grantId: "g1" }, reason: "expired", now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(inf.calls, [["revoke", { token: "t", grantId: "g1", identityId: "i1" }]]);
  const log = await store.readLog("job", "secrets");
  assert.match(log[0].summary, /^Revoked/);
  assert.ok(!JSON.stringify(log).match(/grantId|identityId/));
});

test("revoke: a failure logs problem and returns the error", async () => {
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" }), inf = { ...fakeInf(), revokeGrant: async () => ({ ok: false, error: "grant not found" }) };
  const r = await revoke({ store, inf, token: "t", grant: { identity: "agent-codex", identityId: "i1", path: "/shared/openai", grantId: "g9" }, reason: "expired", now: NOW });
  assert.deepEqual(r, { ok: false, error: "grant not found" });
  assert.equal((await store.readLog("job", "secrets"))[0].kind, "problem");
});

test("integration with the real client on a fake fetch: projectSlug is the configured one, no token in the log", async () => {
  const TOKEN = "tok-" + "x".repeat(40), calls = [];
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (/identity-memberships/.test(url)) return json({ identityMemberships: [{ identity: { id: "i1", name: "agent-codex" } }] });
    if (/POST/.test(init.method) && /temporary/.test(url)) return json({ privilege: { id: "g1" } });
    if (init.method === "DELETE") return json({});
    if (/additional-privilege/.test(url)) return json({ privileges: [{ id: "g1", slug: "keymaster-abc", permissions: [{ conditions: { secretPath: { $glob: "/shared/openai" } } }], isTemporary: true, temporaryAccessEndTime: "2026-11-14T00:00:00Z" }] });
    return new Response("{}", { status: 404 });
  };
  const inf = createInfisical({ baseUrl: "https://inf.test", projectId: "p1", env: "prod", projectSlug: "cfg-slug", fetch });
  const store = createStore(createMemoryRedis(), { space: "fieldnotes" });
  assert.deepEqual(await applyApproved({ store, inf, token: TOKEN, ask, now: NOW }), { ok: true, applied: true });
  const grants = (await inf.listIdentityGrants({ token: TOKEN })).grants;
  assert.equal(grants[0].identityId, "i1");
  assert.deepEqual(await revoke({ store, inf, token: TOKEN, grant: grants[0], reason: "expired", now: NOW + 5 }), { ok: true });
  const add = calls.find((c) => c.method === "POST" && /temporary/.test(c.url));
  assert.equal(add.body.projectSlug, "cfg-slug");
  const del = calls.find((c) => c.method === "DELETE");
  assert.deepEqual(del.body, { privilegeSlug: "keymaster-abc", identityId: "i1", projectSlug: "cfg-slug" });
  assert.ok(!JSON.stringify(await store.readLog("job", "secrets")).includes(TOKEN));
});
