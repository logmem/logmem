// Managed one-click sign-in (one-click connect plan, task 3). Clerk is faked:
// tests inject the session, so no network and no real keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { oauthRedis, withEnv, mockReq, mockRes, callbackOf, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, registerClient, consumeAuthCode, mintTokens } from "../api/oauth/_lib/storage.mjs";
import authorize, { __setManagedDepsForTests, defaultAgentFor } from "../api/oauth/authorize.mjs";
import { inviteMany } from "../src/http/invites.mjs";
import { resolveAuth } from "../src/http/auth.mjs";
import { buildManaged, __clearTenantCacheForTests } from "../api/mcp.mjs";
import { listSignups } from "../src/http/waitlist-store.mjs";

const ENV = { LOGMEM_OAUTH_KEK: TEST_KEK_HEX, VERCEL_ENV: undefined, LOGMEM_MANAGED: "1", LOGMEM_CUSTOMER_REDIS_URI: "rediss://logmem-app:pw@203.0.113.9:6380/0" };
const USER = "user_2abcDEF123ghiJKL";
const EMAIL = "ada+clerk_test@example.com";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function setup({ session = { status: "signed-in", userId: USER, email: EMAIL }, invited = true, redisThrows = false } = {}) {
  const customer = oauthRedis();
  const waitlist = createMemoryRedis();
  __setRedisForTests(customer);
  __clearTenantCacheForTests();
  const calls = { session: 0 };
  __setManagedDepsForTests({
    ready: () => true,
    session: async () => { calls.session++; return typeof session === "function" ? session() : session; },
    redis: () => { if (redisThrows) throw new Error("no customer redis"); return customer; },
    waitlistRedis: () => waitlist,
  });
  if (invited) await inviteMany([EMAIL], { redis: customer });
  const client = await registerClient({ client_name: "Muse", redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" });
  const query = { response_type: "code", client_id: client.client_id, redirect_uri: "https://app.example/cb", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1", scope: "mcp" };
  return { customer, waitlist, client, query, calls };
}

function done() {
  __setManagedDepsForTests(null);
  __setRedisForTests(null);
}

async function get(query) {
  const res = mockRes();
  await authorize(mockReq({ url: "/api/oauth/authorize?" + new URLSearchParams(query) }), res);
  return res;
}

async function approve(query, extra = {}) {
  const page = await get(query);
  assert.equal(page.statusCode, 200, "consent page");
  const cookie = String(page.getHeader("set-cookie")).split(";")[0];
  const csrf = String(page.body).match(/name="csrf_token" value="([^"]+)"/)[1];
  const res = mockRes();
  await authorize(mockReq({ method: "POST", url: "/api/oauth/authorize", body: { ...query, csrf_token: csrf, action: "approve", ...extra }, headers: { cookie } }), res);
  return res;
}

test("managed: signed out goes to Clerk's hosted sign-in, handshake answers 307", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query } = await setup({ session: { status: "signed-out", signInUrl: "https://happy-cat-12.accounts.dev/sign-in?redirect_url=x" } });
      const r = await get(query);
      assert.equal(r.statusCode, 302);
      assert.match(String(r.getHeader("location")), /accounts\.dev\/sign-in/);
      const h = await setup({ session: { status: "handshake", headers: [["location", "https://logmem.test/x"], ["set-cookie", "__session=a"], ["set-cookie", "__client_uat=1"]] } });
      const r2 = await get(h.query);
      assert.equal(r2.statusCode, 307);
      assert.deepEqual(r2.getHeader("set-cookie"), ["__session=a", "__client_uat=1"]);
    } finally {
      done();
    }
  });
});

test("managed: a person who is not invited sees the waitlist page and gets no code", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query, customer, waitlist } = await setup({ invited: false });
      const r = await get(query);
      assert.equal(r.statusCode, 200);
      assert.match(String(r.body), /You(&#39;|')re on the list/);
      assert.ok(!String(r.body).includes("csrf_token"), "no consent form");
      assert.equal(await customer("GET", `lm:account:clerk:${USER}`), null);
      assert.equal((await listSignups(waitlist)).length, 1);
    } finally {
      done();
    }
  });
});

test("managed: the consent page is one button with no Redis or space fields", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query } = await setup();
      const r = await get(query);
      const html = String(r.body);
      assert.equal(r.statusCode, 200);
      assert.match(html, /Allow Muse to use your LogMem memory/);
      assert.match(html, /as the agent <b>muse<\/b>/);
      assert.ok(!/name="space"|upstash|redis_uri|REST/i.test(html), "no Space, Backend or Redis fields");
    } finally {
      done();
    }
  });
});

test("managed: approve mints a code bound to the tenant, its space and the app's agent", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query } = await setup();
      const r = await approve(query);
      const loc = callbackOf(r);
      assert.equal(loc.searchParams.get("state"), "s1");
      const rec = await consumeAuthCode(loc.searchParams.get("code"));
      assert.equal(rec.backend.kind, "managed");
      assert.match(rec.backend.tenant, /^u[a-z0-9]{10}$/);
      assert.equal(rec.backend.agent, "muse");
      assert.equal(rec.space, `t-${rec.backend.tenant}`);
      assert.equal(rec.sub, `clerk:${USER}`);
      assert.equal(rec.upstash_token, null, "no Redis credentials in the token");
    } finally {
      done();
    }
  });
});

test("managed: a custom agent name is used, and a bad one re-shows the page", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query } = await setup();
      const ok = await approve(query, { agent: "muse-work" });
      const rec = await consumeAuthCode(callbackOf(ok).searchParams.get("code"));
      assert.equal(rec.backend.agent, "muse-work");
      const bad = await approve(query, { agent: "not ok!" });
      assert.equal(bad.statusCode, 400);
      assert.match(String(bad.body), /Agent name:/);
    } finally {
      done();
    }
  });
});

test("managed: the token resolves to the jailed customer Redis, locked to its agent, with Free limits", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query, customer } = await setup();
      const r = await approve(query);
      const rec = await consumeAuthCode(callbackOf(r).searchParams.get("code"));
      const tok = await mintTokens(rec);
      const auth = await resolveAuth({ headers: { host: "logmem.test", authorization: `Bearer ${tok.access_token}`, "x-logmem-space": "madez" } }, {}, process.env);
      assert.equal(auth.source, "managed");
      assert.equal(auth.space, rec.space, "the token's space wins over the header");
      assert.equal(auth.pinned, true);
      assert.equal(auth.agent, "muse");
      assert.equal(auth.backend.uri, ENV.LOGMEM_CUSTOMER_REDIS_URI);

      const lm = await buildManaged({ redis: customer, auth, sessionId: "muse.s1" });
      const note = (await lm.callTool("logmem_note", { where: "channel:ideas", summary: "first managed note" })).structuredContent;
      assert.equal(note.ok, true);
      assert.equal(note.entry.by, "agent:muse");
      const keys = [...customer.data.keys()].filter((k) => k.startsWith("lm:") && !k.startsWith("lm:oauth:") && !k.startsWith("lm:invite:") && !k.startsWith("lm:account:"));
      for (const k of keys) assert.ok(k.startsWith(`lm:${rec.space}:`), `outside the space: ${k}`);
      assert.ok([...customer.data.keys()].some((k) => k.startsWith(`acmi:cloud:meter:${rec.backend.tenant}:`)), "adds are metered");
      assert.equal((await lm.callTool("logmem_start", { agent: "atlas" })).isError, true, "other agents are refused");

      const { setStatus } = await import("../cloud/tenants/index.mjs");
      await setStatus(customer, rec.backend.tenant, "suspended");
      await assert.rejects(() => buildManaged({ redis: customer, auth, sessionId: "muse.s1" }), /paused/, "suspending a tenant takes effect immediately without waiting for a cache TTL");
    } finally {
      done();
    }
  });
});

test("managed: no customer Redis is a 503 page, and a managed token without it is unauthenticated", async () => {
  await withEnv(ENV, async () => {
    try {
      const { query } = await setup({ redisThrows: true });
      assert.equal((await get(query)).statusCode, 503);
    } finally {
      done();
    }
  });
  await withEnv({ ...ENV, LOGMEM_CUSTOMER_REDIS_URI: undefined }, async () => {
    try {
      const { query } = await setup();
      const r = await approve(query);
      const tok = await mintTokens(await consumeAuthCode(callbackOf(r).searchParams.get("code")));
      assert.equal((await resolveAuth({ headers: { authorization: `Bearer ${tok.access_token}` } }, {}, process.env)).source, "none");
    } finally {
      done();
    }
  });
});

test("managed: default agent names come from the app name", () => {
  assert.equal(defaultAgentFor("Muse"), "muse");
  assert.equal(defaultAgentFor("Claude Desktop"), "claude-desktop");
  assert.equal(defaultAgentFor(""), "app");
  assert.equal(defaultAgentFor("!!!"), "app");
});

import { primaryEmail } from "../src/http/clerk.mjs";
test("clerk: only a verified primary email counts", () => {
  const user = (status, primary = "e1") => ({ primaryEmailAddressId: primary, emailAddresses: [{ id: "e1", emailAddress: EMAIL, verification: { status } }, { id: "e2", emailAddress: "other@example.com", verification: { status: "verified" } }] });
  assert.equal(primaryEmail(user("verified")), EMAIL);
  assert.equal(primaryEmail(user("unverified")), null, "an unverified primary email is refused");
  assert.equal(primaryEmail(user("verified", "missing")), null);
  assert.equal(primaryEmail(null), null);
});
