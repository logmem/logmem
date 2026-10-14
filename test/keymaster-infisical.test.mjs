// test/keymaster-infisical.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInfisical } from "../cloud/keymaster/infisical.mjs";

const TOKEN = "tok-" + "x".repeat(40), VALUE = "v".repeat(51);
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, h] of routes) if (re.test(`${init.method || "GET"} ${url}`)) return h(url, init);
    return new Response("{}", { status: 404 });
  };
  f.calls = calls;
  return f;
}
const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const base = { baseUrl: "https://inf.test", projectId: "p1", env: "prod" };

test("infisical: login returns a token; getSecretLength returns length only", async () => {
  const fetch = fakeFetch([[/POST .*universal-auth\/login/, () => ok({ accessToken: TOKEN })], [/GET .*secrets\/raw\/CANARY/, () => ok({ secret: { secretValue: VALUE } })]]);
  const inf = createInfisical({ ...base, fetch });
  const l = await inf.login({ clientId: "c", clientSecret: "s" });
  assert.equal(l.ok, true);
  const s = await inf.getSecretLength({ token: l.token, path: "/agents/codex", name: "CANARY" });
  assert.deepEqual(s, { ok: true, length: 51 });
  assert.ok(!JSON.stringify(s).includes(VALUE));
  assert.match(fetch.calls[1].url, /secretPath=%2Fagents%2Fcodex/);
  assert.match(fetch.calls[1].url, /environment=prod/);
});

test("infisical: errors carry no token", async () => {
  const fetch = fakeFetch([[/.*/, () => new Response(`denied for ${TOKEN}`, { status: 403 })]]);
  const inf = createInfisical({ ...base, fetch });
  const r = await inf.getSecretLength({ token: TOKEN, path: "/agents/codex", name: "CANARY" });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  assert.ok(!r.error.includes(TOKEN));
});

test("infisical: listIdentityGrants maps memberships and temporary privileges", async () => {
  const fetch = fakeFetch([
    [/identity-memberships/, () => ok({ identityMemberships: [{ identity: { id: "i1", name: "agent-codex" } }] })],
    [/additional-privilege\/identity/, () => ok({ privileges: [{ id: "g1", permissions: [{ conditions: { secretPath: { $glob: "/shared/openai" } } }], isTemporary: true, temporaryAccessEndTime: "2026-11-14T00:00:00Z" }] })],
  ]);
  const r = await createInfisical({ ...base, fetch }).listIdentityGrants({ token: TOKEN });
  assert.deepEqual(r.grants, [{ identity: "agent-codex", identityId: "i1", path: "/shared/openai", scope: "read", expiresAt: Date.parse("2026-11-14T00:00:00Z"), grantId: "g1" }]);
});

test("infisical: addTemporaryGrant sends slug, projectSlug and a relative ttl", async () => {
  const fetch = fakeFetch([[/POST .*additional-privilege\/identity\/temporary/, () => ok({ privilege: { id: "g9" } })]]);
  const r = await createInfisical({ ...base, projectSlug: "ps", fetch }).addTemporaryGrant({ token: TOKEN, identityId: "i1", path: "/shared/openai", ttlSeconds: 3600 });
  assert.deepEqual(r, { ok: true, grantId: "g9" });
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.projectSlug, "ps");
  assert.equal(body.temporaryRange, "3600s");
  assert.ok(body.slug);
  assert.deepEqual(body.permissions[0].conditions, { environment: "prod", secretPath: { $glob: "/shared/openai" } });
});

test("infisical: addTemporaryGrant refuses a missing time limit before any call", async () => {
  const fetch = fakeFetch([]);
  const r = await createInfisical({ ...base, fetch }).addTemporaryGrant({ token: TOKEN, identityId: "i1", path: "/x" });
  assert.equal(r.ok, false);
  assert.equal(fetch.calls.length, 0);
});

test("infisical: revokeGrant resolves the slug and deletes by body", async () => {
  const fetch = fakeFetch([
    [/GET .*additional-privilege\/identity/, () => ok({ privileges: [{ id: "g1", slug: "keymaster-abc" }] })],
    [/DELETE .*additional-privilege\/identity/, () => ok({ privilege: { id: "g1" } })],
  ]);
  const r = await createInfisical({ ...base, projectSlug: "ps", fetch }).revokeGrant({ token: TOKEN, grantId: "g1", identityId: "i1" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body), { privilegeSlug: "keymaster-abc", identityId: "i1", projectSlug: "ps" });
});

test("infisical: unreachable server gives ok:false, not a throw", async () => {
  const inf = createInfisical({ ...base, fetch: async () => { throw new TypeError(`fetch failed ${TOKEN}`); } });
  const r = await inf.login({ clientId: "c", clientSecret: "s" });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(TOKEN));
});
