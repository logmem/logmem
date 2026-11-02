// WS1 space provisioning: create, invite, list — plus the spec's forged-slug
// acceptance and the fail-closed registry rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createHandler as spacesHandler } from "../api/spaces.mjs";
import { createHandler as inviteHandler } from "../api/spaces/[slug]/invite.mjs";
import { validateSlug, RESERVED_SLUGS } from "../src/http/spaces.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";

const authAs = (sub) => async () => ({ sub, injected: true, backend: { kind: "redis", uri: "redis://injected" } });
const h = (redis, sub) => spacesHandler({ registry: redis, resolveAuth: authAs(sub), env: {} });
const inv = (redis, sub, slug) => {
  const handler = inviteHandler({ registry: redis, resolveAuth: authAs(sub), env: {} });
  return (req, res) => { req.query = { ...(req.query || {}), slug }; return handler(req, res); };
};
const body = (res) => JSON.parse(res.body || "{}");

test("acceptance 4: forged slugs are rejected at create and write nothing", async () => {
  const redis = createMemoryRedis();
  const handler = h(redis, "user_owner");
  const bad = ["..", "a..b", "*", "x*y", "has:colon", "", "-lead", "a b", "tab\there", "agent", "channel", "list", "Admin", "x".repeat(65)];
  for (const slug of bad) {
    const res = mockRes();
    await handler(mockReq({ method: "POST", url: "/api/spaces", body: { slug, name: "x" } }), res);
    assert.ok([400].includes(res.statusCode), `${JSON.stringify(slug)} -> ${res.statusCode} ${res.body}`);
    assert.match(body(res).error, /slug|reserved/, JSON.stringify(slug));
  }
  const left = (await redis("KEYS", "sp:*")).length;
  assert.equal(left, 0, "no registry keys written by refused creates");
  // input normalizes, but only ever into a clean stored key
  const norm = mockRes();
  await handler(mockReq({ method: "POST", url: "/api/spaces", body: { slug: "  Lead  ", name: "x" } }), norm);
  assert.equal(norm.statusCode, 201, norm.body);
  assert.equal(body(norm).space.slug, "lead", "trimmed and lowercased into a clean key");
});

test("create seeds the owner, duplicate is 409, list scopes to the member", async () => {
  const redis = createMemoryRedis();
  const owner = h(redis, "user_owner");
  const res = mockRes();
  await owner(mockReq({ method: "POST", url: "/api/spaces", body: { slug: "Client-Acme", name: "Acme space" } }), res);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(body(res).space.slug, "client-acme", "slug lowercases");
  assert.equal(body(res).space.role, "owner");

  const dup = mockRes();
  await owner(mockReq({ method: "POST", url: "/api/spaces", body: { slug: "client-acme" } }), dup);
  assert.equal(dup.statusCode, 409, "second create refuses, never overwrites");

  const ownerList = mockRes();
  await owner(mockReq({ method: "GET", url: "/api/spaces" }), ownerList);
  assert.deepEqual(body(ownerList).spaces.map((s) => s.slug), ["client-acme"]);

  const outsiderList = mockRes();
  await h(redis, "user_outsider")(mockReq({ method: "GET", url: "/api/spaces" }), outsiderList);
  assert.deepEqual(body(outsiderList).spaces, [], "an identity with no membership sees nothing");
});

test("invite: owner invites, member cannot, outsider cannot, bad role refused", async () => {
  const redis = createMemoryRedis();
  await h(redis, "user_owner")(mockReq({ method: "POST", url: "/api/spaces", body: { slug: "team-one" } }), mockRes());

  const ok = mockRes();
  await inv(redis, "user_owner", "team-one")(mockReq({ method: "POST", url: "/api/spaces/team-one/invite", body: { identity: "user_member1", role: "member" } }), ok);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(body(ok).role, "member");

  const byMember = mockRes();
  await inv(redis, "user_member1", "team-one")(mockReq({ method: "POST", url: "/api/spaces/team-one/invite", body: { identity: "user_x", role: "admin" } }), byMember);
  assert.equal(byMember.statusCode, 403, "members cannot invite");

  const byOutsider = mockRes();
  await inv(redis, "user_outsider", "team-one")(mockReq({ method: "POST", url: "/api/spaces/team-one/invite", body: { identity: "user_y", role: "member" } }), byOutsider);
  assert.equal(byOutsider.statusCode, 403, "non-members cannot invite into a space");

  const badRole = mockRes();
  await inv(redis, "user_owner", "team-one")(mockReq({ method: "POST", url: "/api/spaces/team-one/invite", body: { identity: "user_z", role: "root" } }), badRole);
  assert.equal(badRole.statusCode, 400, "role outside owner admin member refused");

  const list = mockRes();
  await h(redis, "user_member1")(mockReq({ method: "GET", url: "/api/spaces" }), list);
  assert.deepEqual(body(list).spaces.map((s) => [s.slug, s.role]), [["team-one", "member"]], "invitee sees the space with their role");
});

test("acceptance 1 at route level: identity B cannot see or touch A's space membership", async () => {
  const redis = createMemoryRedis();
  await h(redis, "user_a")(mockReq({ method: "POST", url: "/api/spaces", body: { slug: "space-a" } }), mockRes());
  const bList = mockRes();
  await h(redis, "user_b")(mockReq({ method: "GET", url: "/api/spaces" }), bList);
  assert.deepEqual(body(bList).spaces, []);
  const bInvite = mockRes();
  await inv(redis, "user_b", "space-a")(mockReq({ method: "POST", url: "/api/spaces/space-a/invite", body: { identity: "user_b", role: "owner" } }), bInvite);
  assert.equal(bInvite.statusCode, 403, "B cannot grant itself ownership of A's space");
});

test("fail closed: no registry env means 503 and no fallback to any other store", async () => {
  const handler = spacesHandler({ env: {}, resolveAuth: authAs("user_owner") });
  const res = mockRes();
  await handler(mockReq({ method: "GET", url: "/api/spaces" }), res);
  assert.equal(res.statusCode, 503, res.body);
  assert.equal(body(res).error, "registry_not_configured");
});

test("auth is required: no identity, no route", async () => {
  const handler = spacesHandler({ registry: createMemoryRedis(), resolveAuth: async () => ({}) });
  const res = mockRes();
  await handler(mockReq({ method: "GET", url: "/api/spaces" }), res);
  assert.equal(res.statusCode, 401, res.body);
});

test("slug rules hold as a unit: reserved list is structural words only", () => {
  assert.throws(() => validateSlug("channel"), /reserved/);
  assert.throws(() => validateSlug("client:suzanne"), /slug must be/);
  assert.equal(validateSlug("client-suzanne"), "client-suzanne");
  assert.ok(RESERVED_SLUGS.has("log") && RESERVED_SLUGS.has("registry"));
});
