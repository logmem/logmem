// Two managed tenants on one in-memory customer Redis cannot see or change
// each other's data. This is the MCP-side follow-up to grok-local's #62 review
// and to PR #73, which only proved that /api/inbox returns 403.
//
// The HTTP handler in api/mcp.mjs would dial LOGMEM_CUSTOMER_REDIS_URI through
// a native Redis client. These tests never do that. They resolve a real managed
// token (so the auth object is the one the handler would pass), then call
// dispatch + buildManaged — the same branch the handler uses for
// auth.source === "managed" — with an in-memory runner standing in for that
// client. Raw SET / DEL / SCAN attacks go through createJail and createLimits.
// No production Redis, no network, no env files.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { oauthRedis, withEnv, TEST_KEK_HEX } from "./oauth-helpers.mjs";
import { __setRedisForTests, mintTokens } from "../api/oauth/_lib/storage.mjs";
import { resolveAuth } from "../src/http/auth.mjs";
import { buildManaged, dispatch, scopedSessionId, __clearTenantCacheForTests } from "../api/mcp.mjs";
import { createJail, tenantSpace, JailError } from "../src/http/jail.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { createTenant, setStatus, getTenant } from "../cloud/tenants/index.mjs";
import { inJail } from "../cloud/bridge/bridge.mjs";
import { usage } from "../cloud/meter/index.mjs";

const A = "uaaaaaaaaaa";
const B = "ubbbbbbbbbb";
const AGENT = "muse";
const A_NOTE = "auroraquillmarker";
const B_NOTE = "borealquillmarker";
const FLEET_NOTE = "fleetmadezmarker";
const SIBLING_NOTE = "siblingextramarker";
const PLANTED_A = "aplantedmarker";
const PLANTED_B = "bplantedmarker";

// Documentation address (TEST-NET-3). Resolved into the token, never dialed.
const CUSTOMER_URI = "rediss://logmem-app:pw@203.0.113.9:6380/0";
const ENV = {
  LOGMEM_OAUTH_KEK: TEST_KEK_HEX,
  VERCEL_ENV: "production",
  NODE_ENV: "test",
  LOGMEM_CUSTOMER_REDIS_URI: CUSTOMER_URI,
  LOGMEM_REDIS_URI: undefined,
  ACMI_REDIS_URI: undefined,
  LOGMEM_REST_URL: undefined,
  LOGMEM_REST_TOKEN: undefined,
  LOGMEM_DEPLOY_REDIS_URI: undefined,
  UPSTASH_REDIS_REST_URL: undefined,
  UPSTASH_REDIS_REST_TOKEN: undefined,
  ACMI_BRIDGE_URL: undefined,
  ACMI_BRIDGE_TOKEN: undefined,
};

function assertNeverDialed() {
  const cache = globalThis.__acmiNativeClients;
  assert.ok(!cache || cache.size === 0, "a test opened a native Redis client");
}

async function fixture(fn) {
  await withEnv(ENV, async () => {
    const oauth = oauthRedis();
    const customer = oauthRedis();
    __setRedisForTests(oauth);
    __clearTenantCacheForTests();
    try {
      await fn(customer);
      assertNeverDialed();
    } finally {
      __setRedisForTests(null);
      __clearTenantCacheForTests();
    }
  });
}

/** The auth object resolveAuth returns for a managed bearer. Header space is madez and must lose. */
async function managedAuth(tenant, space = tenantSpace(tenant)) {
  const tok = await mintTokens({
    client_id: "cli_isolation",
    scope: "mcp",
    upstash_url: null,
    upstash_token: null,
    backend: { kind: "managed", tenant, agent: AGENT },
    sub: "clerk:user_isolation",
    space,
  });
  const auth = await resolveAuth(
    { headers: { authorization: `Bearer ${tok.access_token}`, "x-logmem-space": "madez", host: "logmem.test" } },
    {},
    process.env,
  );
  assert.equal(auth.source, "managed");
  assert.equal(auth.tenant, tenant);
  assert.equal(auth.agent, AGENT);
  assert.equal(auth.space, space, "token space wins over x-logmem-space: madez");
  assert.equal(auth.pinned, true);
  assert.equal(auth.backend.uri, CUSTOMER_URI);
  return auth;
}

/** One tools/call, the way api/mcp.mjs serves a managed session. */
async function tool(redis, auth, name, args, sessionId = `muse.${auth.tenant}`) {
  const reply = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    {
      toolDefs: () => [],
      lmFactory: () => buildManaged({ redis, auth, sessionId: scopedSessionId(sessionId, auth) }),
    },
  );
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return reply.result;
}

function keysOf(redis) {
  return [...redis.data.keys()].sort();
}

function valuesOf(redis) {
  const parts = [];
  for (const [key, entry] of redis.data) {
    parts.push(key);
    if (!entry) continue;
    if (entry.type === "string") parts.push(entry.value);
    else if (entry.type === "hash" || entry.type === "zset") {
      parts.push(...entry.value.keys(), ...[...entry.value.values()].map(String));
    } else if (entry.type === "set" || entry.type === "list") parts.push(...entry.value);
    else if (entry.type === "stream") {
      for (const [, fields] of entry.value) parts.push(...fields);
    }
  }
  return parts.map(String).join("\n");
}

async function refused(jail, redis, args) {
  const n = redis.calls.length;
  await assert.rejects(() => jail(...args), (err) => {
    assert.ok(err instanceof JailError, `${args.join(" ")} threw ${err?.name}: ${err?.message}`);
    assert.equal(err.message, "jail: command not allowed");
    assert.equal(err.status, 403);
    return true;
  }, args.join(" "));
  assert.equal(redis.calls.length, n, `${args.join(" ")} reached Redis`);
}

async function seedPair(customer) {
  await createTenant(customer, { id: A, name: "Tenant A", plan: "free" });
  await createTenant(customer, { id: B, name: "Tenant B", plan: "free" });
  return { authA: await managedAuth(A), authB: await managedAuth(B) };
}

describe("two managed tenants cannot see or change each other's data", { concurrency: 1 }, () => {
  test("isolation: A's note is invisible to B's read, list, search, scan and recall, and the reverse", async () => {
    await fixture(async (customer) => {
      const { authA, authB } = await seedPair(customer);
      const wroteA = await tool(customer, authA, "logmem_note", { where: "channel:aurora-room", summary: A_NOTE });
      const wroteB = await tool(customer, authB, "logmem_note", { where: "channel:boreal-room", summary: B_NOTE });
      assert.equal(wroteA.structuredContent.ok, true, JSON.stringify(wroteA.structuredContent));
      assert.equal(wroteB.structuredContent.ok, true, JSON.stringify(wroteB.structuredContent));
      assert.equal(wroteA.structuredContent.entry.by, "agent:muse");
      assert.equal(wroteB.structuredContent.entry.by, "agent:muse");

      const stored = keysOf(customer);
      assert.ok(stored.some((k) => k.startsWith(`lm:t-${A}:`) && k.includes("aurora-room")), "A's note key");
      assert.ok(stored.some((k) => k.startsWith(`lm:t-${B}:`) && k.includes("boreal-room")), "B's note key");
      assert.ok(stored.some((k) => k.startsWith(`acmi:cloud:meter:${A}:`)), "A's adds are metered on A's id");
      assert.ok(stored.some((k) => k.startsWith(`acmi:cloud:meter:${B}:`)), "B's adds are metered on B's id");
      assert.equal(Number(await customer("SISMEMBER", `lm:${tenantSpace(A)}:agents`, AGENT)), 1);
      assert.equal(Number(await customer("SISMEMBER", `lm:${tenantSpace(B)}:agents`, AGENT)), 1);

      await assertHidden(customer, authB, { secret: A_NOTE, channel: "aurora-room", other: A, own: B_NOTE, ownChannel: "boreal-room" });
      await assertHidden(customer, authA, { secret: B_NOTE, channel: "boreal-room", other: B, own: A_NOTE, ownChannel: "aurora-room" });
    });
  });

  test("isolation: B cannot write, delete or overwrite lm:t-{A}: or lm:madez:", async () => {
    await fixture(async (customer) => {
      const { authA, authB } = await seedPair(customer);
      const wrote = await tool(customer, authA, "logmem_note", { where: "channel:aurora-room", summary: A_NOTE });
      assert.equal(wrote.structuredContent.ok, true, JSON.stringify(wrote.structuredContent));
      const aLog = `lm:t-${A}:channel:aurora-room:log`;
      await customer("SET", `lm:t-${A}:planted`, PLANTED_A);
      await customer("SET", `lm:t-${B}:planted`, PLANTED_B);
      await customer("SET", "lm:madez:planted", FLEET_NOTE);
      await customer("SET", "lm:madez:agent:atlas:log", "fleetlogmarker");
      await customer("SET", "lm:oauth:client:x", "oauthmarker");
      await customer("SET", "lm:account:clerk:user_isolation", "accountmarker");

      // A's note already took A's agent slot. B's limits must take a slot only on B.
      const limitsB = createLimits({ redis: customer, tenant: B, plan: "free" });
      await limitsB.agentSlot("quill");
      assert.deepEqual([...(await customer("SMEMBERS", `lm:${tenantSpace(A)}:agents`))].sort(), ["muse"]);
      assert.deepEqual([...(await customer("SMEMBERS", `lm:${tenantSpace(B)}:agents`))].sort(), ["quill"]);
      assert.equal(Number(await customer("EXISTS", "lm:madez:agents")), 0);

      const jailB = createJail(customer, B);
      assert.equal(await jailB("GET", `lm:t-${B}:planted`), PLANTED_B, "B can still read inside its own jail");
      const foreign = [
        aLog,
        `lm:t-${A}:planted`,
        `lm:t-${A}:brand-new`,
        "lm:madez:planted",
        "lm:madez:agent:atlas:log",
        "lm:madez:brand-new",
        "lm:oauth:client:x",
        "lm:account:clerk:user_isolation",
        `acmi:cloud:tenant:${A}`,
      ];
      for (const key of foreign) {
        await refused(jailB, customer, ["SET", key, "overwritemarker"]);
        await refused(jailB, customer, ["GET", key]);
        await refused(jailB, customer, ["DEL", key]);
      }
      await refused(jailB, customer, ["DEL", `lm:t-${B}:planted`, `lm:t-${A}:planted`]);
      await refused(jailB, customer, ["MGET", `lm:t-${B}:planted`, aLog]);
      await refused(jailB, customer, ["MSET", `lm:t-${B}:ok`, "1", `lm:t-${A}:planted`, "overwritemarker"]);
      await refused(jailB, customer, ["MSET", `lm:t-${B}:ok`, "1", "lm:madez:planted", "overwritemarker"]);
      await refused(jailB, customer, ["RENAME", `lm:t-${B}:planted`, `lm:t-${A}:planted`]);
      await refused(jailB, customer, ["RENAME", `lm:t-${B}:planted`, "lm:madez:planted"]);
      await refused(jailB, customer, ["COPY", `lm:t-${A}:planted`, `lm:t-${B}:stolen`]);
      await refused(jailB, customer, ["COPY", "lm:madez:planted", `lm:t-${B}:stolen`]);
      await refused(jailB, customer, ["SADD", `lm:${tenantSpace(A)}:agents`, "quill"]);
      await refused(jailB, customer, ["SADD", "lm:madez:agents", "quill"]);

      const logCard = Number(await customer("ZCARD", aLog));
      for (const key of [aLog, `lm:t-${A}:planted`, "lm:madez:planted", "lm:madez:agent:atlas:log"]) {
        const preview = await tool(customer, authB, "logmem_remove", { key });
        const gone = await tool(customer, authB, "logmem_remove", { key, confirm: true });
        assert.equal(preview.isError, true, JSON.stringify(preview.structuredContent));
        assert.equal(gone.isError, true, JSON.stringify(gone.structuredContent));
        const body = JSON.stringify(gone.structuredContent);
        assert.ok(!body.includes(A_NOTE) && !body.includes(FLEET_NOTE) && !body.includes(PLANTED_A), body);
      }

      for (const where of ["channel:*", "channel:a?x", "channel:a[b]", "channel:has:colon", `channel:t-${A}:secret`]) {
        const bad = await tool(customer, authB, "logmem_note", { where, summary: "evilmarker" });
        assert.equal(bad.isError, true, where + " " + JSON.stringify(bad.structuredContent));
      }

      // Token space disagrees with the tenant. The store aims at that space; the jail must drop it.
      for (const space of [tenantSpace(A), "madez"]) {
        const mismatch = await managedAuth(B, space);
        assert.equal(mismatch.tenant, B);
        assert.equal(mismatch.space, space);
        const note = await tool(customer, mismatch, "logmem_note", { where: "channel:smuggled", summary: "smugglemarker" });
        assert.equal(note.isError, true, JSON.stringify(note.structuredContent));
        assert.equal(note.structuredContent.error, "internal error");
      }

      assert.equal(await customer("GET", `lm:t-${A}:planted`), PLANTED_A);
      assert.equal(await customer("GET", `lm:t-${B}:planted`), PLANTED_B);
      assert.equal(await customer("GET", "lm:madez:planted"), FLEET_NOTE);
      assert.equal(await customer("GET", "lm:madez:agent:atlas:log"), "fleetlogmarker");
      assert.equal(Number(await customer("EXISTS", `lm:t-${A}:brand-new`)), 0);
      assert.equal(Number(await customer("EXISTS", "lm:madez:brand-new")), 0);
      assert.equal(Number(await customer("EXISTS", `lm:t-${B}:stolen`)), 0);
      assert.equal(Number(await customer("ZCARD", aLog)), logCard);
      const blob = valuesOf(customer);
      assert.ok(blob.includes(A_NOTE));
      assert.ok(!blob.includes("overwritemarker"));
      assert.ok(!blob.includes("smugglemarker"));
      assert.ok(!blob.includes("evilmarker"));

      const reread = await tool(customer, authA, "logmem_view", { ref: "channel:aurora-room", limit: 20 });
      assert.equal(reread.structuredContent.ok, true, JSON.stringify(reread.structuredContent));
      assert.ok(JSON.stringify(reread.structuredContent.log).includes(A_NOTE));
      const meter = await usage(customer, A);
      const afterRemove = await tool(customer, authB, "logmem_remove", { key: aLog, confirm: true });
      assert.equal(afterRemove.isError, true);
      assert.deepEqual(await usage(customer, A), meter, "B's refusals must not change A's meter");
    });
  });

  test("isolation: sibling prefix lm:t-{A}EXTRA: is not inside A's jail", async () => {
    await fixture(async (customer) => {
      await createTenant(customer, { id: A, name: "Tenant A", plan: "free" });
      const authA = await managedAuth(A);
      const prefix = `lm:${tenantSpace(A)}:`;
      const sibling = `lm:t-${A}EXTRA:secret`;
      await customer("SET", sibling, SIBLING_NOTE);
      await customer("SET", prefix.slice(0, -1), "bareprefixmarker");
      await customer("SET", prefix, "exactprefixmarker");
      await customer("SET", `${prefix}inside`, "insidemarker");

      assert.equal(inJail(`${prefix}inside`, [prefix]), true);
      assert.equal(inJail(sibling, [prefix]), false, "EXTRA is a different prefix, not a longer key");
      assert.equal(inJail(prefix, [prefix]), false, "the bare prefix is not strictly inside the jail");
      assert.equal(inJail(prefix.slice(0, -1), [prefix]), false);

      const jail = createJail(customer, A);
      assert.equal(await jail("GET", `${prefix}inside`), "insidemarker");
      await refused(jail, customer, ["GET", sibling]);
      await refused(jail, customer, ["SET", sibling, "nope"]);
      await refused(jail, customer, ["DEL", sibling]);
      await refused(jail, customer, ["GET", prefix]);
      await refused(jail, customer, ["SET", prefix, "nope"]);
      await refused(jail, customer, ["GET", prefix.slice(0, -1)]);

      const [, scanned] = await jail("SCAN", "0");
      assert.ok(scanned.includes(`${prefix}inside`), scanned.join(","));
      assert.ok(!scanned.includes(sibling), scanned.join(","));
      assert.ok(!scanned.some((k) => k.startsWith(`lm:t-${A}EXTRA:`)), scanned.join(","));
      assert.ok(!scanned.includes(prefix.slice(0, -1)), scanned.join(","));
      // MATCH prefix* uses Redis *, which also matches an empty tail, so the
      // boundary key lm:t-{id}: can appear by name. The value does not: GET,
      // SET and DEL of that key are refused above.
      assert.ok(!scanned.includes("exactprefixmarker") && !scanned.includes(SIBLING_NOTE), scanned.join(","));
      assert.equal(await customer("GET", sibling), SIBLING_NOTE);

      const recall = await tool(customer, authA, "logmem_recall", { query: SIBLING_NOTE, limit: 20 });
      assert.equal(recall.structuredContent.ok, true, JSON.stringify(recall.structuredContent));
      assert.deepEqual(recall.structuredContent.results, []);
      assert.equal(recall.structuredContent.query, SIBLING_NOTE, "recall echoes the query; that is not a hit");
      const recallBody = { ...recall.structuredContent };
      delete recallBody.query;
      const packed = JSON.stringify(recallBody);
      assert.ok(!packed.includes(SIBLING_NOTE));
      assert.ok(!packed.includes(`${A}EXTRA`));
    });
  });

  test("isolation: a glob SCAN or MATCH cannot widen into another tenant, madez, or the sibling prefix", async () => {
    await fixture(async (customer) => {
      await createTenant(customer, { id: A, name: "Tenant A", plan: "free" });
      await createTenant(customer, { id: B, name: "Tenant B", plan: "free" });
      const prefix = `lm:${tenantSpace(A)}:`;
      await customer("SET", `${prefix}planted`, PLANTED_A);
      await customer("SET", `${prefix}channel:aurora-room:log`, "alogmarker");
      await customer("SET", `lm:t-${B}:planted`, PLANTED_B);
      await customer("SET", `lm:t-${B}:channel:boreal-room:log`, "blogmarker");
      await customer("SET", "lm:madez:planted", FLEET_NOTE);
      await customer("SET", `lm:t-${A}EXTRA:secret`, SIBLING_NOTE);
      await customer("SET", "lm:oauth:client:x", "oauthmarker");
      await customer("SET", `lm:account:tenant:${A}`, "accountmarker");

      const jail = createJail(customer, A);
      const logKey = `${prefix}channel:aurora-room:log`;
      const scan = async (pattern) => {
        const [, keys] = pattern ? await jail("SCAN", "0", "MATCH", pattern) : await jail("SCAN", "0");
        const sent = customer.calls.at(-1);
        assert.equal(sent[0], "SCAN");
        assert.equal(sent[2], "MATCH");
        if (pattern) assert.equal(sent[3], pattern);
        else assert.equal(sent[3], `${prefix}*`);
        assert.ok(String(sent[3]).startsWith(prefix), `rewritten MATCH ${sent[3]}`);
        for (const key of keys) {
          assert.ok(key.startsWith(prefix) && key.length > prefix.length, `${pattern || "(default)"} returned ${key}`);
          assert.ok(!key.startsWith(`lm:t-${B}:`) && !key.startsWith("lm:madez:") && !key.startsWith(`lm:t-${A}EXTRA:`) && !key.startsWith("lm:oauth:") && !key.startsWith("lm:account:"), `${pattern || "default"} widened to ${key}`);
        }
        const flat = keys.join("\n");
        assert.ok(!flat.includes(PLANTED_B) && !flat.includes(FLEET_NOTE) && !flat.includes(SIBLING_NOTE));
        return keys;
      };

      const all = await scan(null);
      assert.deepEqual(all, [`${prefix}planted`, logKey].sort());
      assert.deepEqual(await scan(`${prefix}*`), all);
      assert.deepEqual(await scan(`${prefix}channel:*`), [logKey]);
      assert.deepEqual(await scan(`${prefix}*log`), [logKey]);
      assert.deepEqual(await scan(`lm:${tenantSpace(A)}:*:log`), [logKey]);
      // A newline after the prefix still starts with the prefix, so the jail allows it.
      // The match is per key: another tenant's key does not begin with this prefix.
      assert.deepEqual(await scan(`${prefix}*\n*`), []);

      // Each of these would match another tenant, the fleet tree, or the sibling if it ran.
      const widened = [
        "*",
        "lm:*",
        "lm:t-*",
        `lm:t-${A}*`,
        `lm:t-${A}EXTRA:*`,
        `lm:t-${A}?:*`,
        `lm:t-${A.slice(0, -1)}?:*`,
        `lm:t-${B}:*`,
        `lm:t-?${A.slice(1)}:*`,
        `*${prefix}*`,
        "lm:madez:*",
        "lm:oauth:*",
        "lm:account:*",
        `${prefix.slice(0, -1)}*`,
        `lm:t-${A[0]}*`,
      ];
      for (const pattern of widened) await refused(jail, customer, ["SCAN", "0", "MATCH", pattern]);
      await refused(jail, customer, ["KEYS", `${prefix}*`]);
      await refused(jail, customer, ["KEYS", "*"]);

      for (const bad of ["uab*", "uab?", "uab[c]", "u*bbbbbbbbb", `${A}*`, `${A}?`]) {
        assert.throws(() => createJail(customer, bad), bad);
      }

      assert.equal(await customer("GET", `lm:t-${B}:planted`), PLANTED_B);
      assert.equal(await customer("GET", "lm:madez:planted"), FLEET_NOTE);
      assert.equal(await customer("GET", `lm:t-${A}EXTRA:secret`), SIBLING_NOTE);
    });
  });

  test("isolation: a suspended, missing, half-written, deleted or invalid tenant writes nothing", async () => {
    await fixture(async (customer) => {
      const suspended = "ususpend01";
      await createTenant(customer, { id: suspended, name: "Suspended", plan: "free" });
      await setStatus(customer, suspended, "suspended");
      await expectNoWrite(customer, suspended);

      await expectNoWrite(customer, "umissingmiss");

      const half = "uhalfwritten";
      await customer("HSET", `acmi:cloud:tenant:${half}`, "id", half, "name", "half", "plan", "free", "namespace", `t-${half}`);
      assert.equal((await getTenant(customer, half)).status, "suspended");
      await expectNoWrite(customer, half);

      const deleted = "udeleteddel";
      await createTenant(customer, { id: deleted, name: "Deleted", plan: "free" });
      await setStatus(customer, deleted, "deleted");
      await expectNoWrite(customer, deleted);

      for (const bad of ["madez", "ab", "not-a-tenant", "uab*", "../x"]) {
        const before = keysOf(customer);
        __clearTenantCacheForTests();
        const auth = bad === "madez" ? await managedAuth("madez", "madez") : {
          source: "managed", tenant: bad, agent: AGENT, space: "madez", pinned: true, keyId: "mf_bad",
          backend: { kind: "redis", uri: CUSTOMER_URI },
        };
        await assert.rejects(() => buildManaged({ redis: customer, auth, sessionId: "muse.bad" }), /paused/, bad);
        const reply = await dispatch(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "logmem_note", arguments: { where: "channel:ideas", summary: "shouldnotland" } } },
          { toolDefs: () => [], lmFactory: () => buildManaged({ redis: customer, auth, sessionId: "muse.bad.rpc" }) },
        );
        assert.equal(reply.result.isError, true, bad);
        assert.equal(reply.result.structuredContent.ok, false, bad);
        assert.deepEqual(keysOf(customer), before, bad);
      }
      assert.ok(!valuesOf(customer).includes("shouldnotland"));
    });
  });

  test("isolation: once the 60s tenant cache expires, a suspension fails closed", async () => {
    await fixture(async (customer) => {
      const id = "ucacheexpire";
      await createTenant(customer, { id, name: "Cache", plan: "free" });
      const auth = await managedAuth(id);
      let clock = 1_700_000_000_000;
      const now = () => clock;
      const lm = await buildManaged({ redis: customer, auth, sessionId: "muse.cache", now });
      const note = await lm.callTool("logmem_note", { where: "channel:ideas", summary: "whileactive" });
      assert.equal(note.structuredContent.ok, true, JSON.stringify(note.structuredContent));
      await setStatus(customer, id, "suspended");
      clock += 60_001;
      const before = keysOf(customer);
      await assert.rejects(() => buildManaged({ redis: customer, auth, sessionId: "muse.after", now }), /paused/);
      const reply = await dispatch(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "logmem_note", arguments: { where: "channel:ideas", summary: "aftersuspend" } } },
        { toolDefs: () => [], lmFactory: () => buildManaged({ redis: customer, auth, sessionId: "muse.after.rpc", now }) },
      );
      assert.equal(reply.result.isError, true);
      assert.deepEqual(keysOf(customer), before);
      assert.ok(!valuesOf(customer).includes("aftersuspend"));
    });
  });

  // Known fail-open, not fixed here. buildManaged caches the tenant row for 60s
  // (TENANT_TTL_MS in api/mcp.mjs). After one successful lookup, setStatus(suspended)
  // does not stop the next tools/call until that entry expires, so a paused
  // account can still append. This is not a cross-tenant read: the jail still
  // allows only lm:t-{id}:. A cold lookup and an expired cache entry do fail closed
  // (covered above).
  test("isolation: a suspension fails closed inside the 60s tenant cache window", { todo: true }, async () => {
    await fixture(async (customer) => {
      const id = "ucacheleak01";
      await createTenant(customer, { id, name: "Leak", plan: "free" });
      const auth = await managedAuth(id);
      const first = await buildManaged({ redis: customer, auth, sessionId: "muse.cached" });
      const opened = await first.callTool("logmem_note", { where: "channel:ideas", summary: "beforepause" });
      assert.equal(opened.structuredContent.ok, true, JSON.stringify(opened.structuredContent));
      await setStatus(customer, id, "suspended");
      let served = "paused";
      try {
        await buildManaged({ redis: customer, auth, sessionId: "muse.still" });
        served = "served";
      } catch (e) {
        served = e.message;
      }
      const reply = await dispatch(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "logmem_note", arguments: { where: "channel:ideas", summary: "writtenwhilesuspended" } } },
        { toolDefs: () => [], lmFactory: () => buildManaged({ redis: customer, auth, sessionId: "muse.still.rpc" }) },
      );
      const landed = valuesOf(customer).includes("writtenwhilesuspended");
      const callSucceeded = reply.result?.isError !== true && reply.result?.structuredContent?.ok === true;
      assert.equal(
        served,
        "This LogMem account is paused.",
        `LEAK: buildManaged still ${served} this tenant after setStatus(suspended), because the row was cached for 60s (api/mcp.mjs TENANT_TTL_MS). ` +
          `The next logmem_note ${callSucceeded ? "succeeded" : "failed"} and the text landed in Redis: ${landed}. ` +
          "A paused account can still append into its own lm:t-{id}: space until the cache expires. Not a cross-tenant read. Not fixed in this PR.",
      );
      assert.equal(reply.result.isError, true);
      assert.equal(landed, false);
    });
  });
});

async function assertHidden(customer, auth, { secret, channel, other, own, ownChannel }) {
  const view = await tool(customer, auth, "logmem_view", { ref: `channel:${channel}`, limit: 50 });
  const ownView = await tool(customer, auth, "logmem_view", { ref: `channel:${ownChannel}`, limit: 50 });
  const feed = await tool(customer, auth, "logmem_feed", { refs: ["channel:aurora-room", "channel:boreal-room"], limit: 50 });
  const roster = await tool(customer, auth, "logmem_roster", { of: "channel" });
  const jobs = await tool(customer, auth, "logmem_jobs", {});
  const recall = await tool(customer, auth, "logmem_recall", { query: secret, limit: 20 });
  const brief = await tool(customer, auth, "logmem_brief", {});
  const spaces = await tool(customer, auth, "logmem_spaces", {});
  const compat = await tool(customer, auth, "acmi_search_semantic", { query: secret });

  assert.equal(view.structuredContent.ok, true, JSON.stringify(view.structuredContent));
  assert.deepEqual(view.structuredContent.log, [], `view of the other channel returned rows: ${JSON.stringify(view.structuredContent.log)}`);
  assert.equal(ownView.structuredContent.ok, true);
  assert.ok(JSON.stringify(ownView.structuredContent.log).includes(own), "a tenant must still see its own note");
  assert.equal(feed.structuredContent.ok, true, JSON.stringify(feed.structuredContent));
  assert.ok(!JSON.stringify(feed.structuredContent.entries).includes(secret));
  assert.equal(roster.structuredContent.ok, true, JSON.stringify(roster.structuredContent));
  assert.ok(!roster.structuredContent.ids.includes(channel), `roster listed ${channel}: ${roster.structuredContent.ids}`);
  assert.equal(jobs.structuredContent.ok, true, JSON.stringify(jobs.structuredContent));
  assert.equal(recall.structuredContent.ok, true, JSON.stringify(recall.structuredContent));
  assert.deepEqual(recall.structuredContent.results, []);
  assert.equal(recall.structuredContent.mode, "keyword");
  assert.equal(brief.structuredContent.ok, true, JSON.stringify(brief.structuredContent));
  assert.equal(spaces.structuredContent.space, auth.space);
  assert.deepEqual(spaces.structuredContent.spaces, [auth.space]);
  assert.equal(compat.isError, true);
  assert.match(compat.structuredContent.error, /unknown tool/);

  // recall echoes the query we sent. Drop that field before looking for a leak.
  const { query: _echoed, ...recallBody } = recall.structuredContent;
  assert.equal(_echoed, secret);
  const packed = JSON.stringify({
    view: view.structuredContent,
    feed: feed.structuredContent,
    roster: roster.structuredContent,
    jobs: jobs.structuredContent,
    recall: recallBody,
    brief: brief.structuredContent,
    spaces: spaces.structuredContent,
  });
  assert.ok(!packed.includes(secret), `tool results contained the other tenant's note: ${packed.slice(0, 500)}`);
  assert.ok(!packed.includes(`lm:t-${other}:`), "tool results contained the other tenant's key prefix");

  const jail = createJail(customer, auth.tenant);
  const foreign = keysOf(customer).filter((k) => k.startsWith(`lm:t-${other}:`));
  assert.ok(foreign.length > 0);
  for (const key of foreign) await refused(jail, customer, ["GET", key]);
  const [, scanned] = await jail("SCAN", "0");
  const prefix = `lm:${auth.space}:`;
  for (const key of scanned) {
    assert.ok(key.startsWith(prefix) && key.length > prefix.length, key);
    assert.ok(!key.startsWith(`lm:t-${other}:`), key);
  }
  assert.ok(scanned.length > 0, "SCAN still returns the caller's own keys");
}

async function expectNoWrite(customer, tenant) {
  __clearTenantCacheForTests();
  const auth = await managedAuth(tenant);
  const before = keysOf(customer);
  await assert.rejects(() => buildManaged({ redis: customer, auth, sessionId: `muse.${tenant}` }), /paused/, tenant);
  const reply = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "logmem_note", arguments: { where: "channel:ideas", summary: "shouldnotland" } } },
    { toolDefs: () => [], lmFactory: () => buildManaged({ redis: customer, auth, sessionId: `muse.${tenant}.rpc` }) },
  );
  assert.equal(reply.result.isError, true, tenant);
  assert.equal(reply.result.structuredContent.ok, false, JSON.stringify(reply.result.structuredContent));
  assert.deepEqual(keysOf(customer), before, `${tenant} wrote keys`);
  assert.ok(!valuesOf(customer).includes("shouldnotland"));
}
