import { test, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import {
  RESERVED, validTenantId, createTenant, getTenant, listTenants, setStatus,
  createKey, verifyKey, rotateKey, revokeKey, listKeys, loadPlans, planFor,
} from "../cloud/tenants/index.mjs";

const KEY_RE = /^acmi_live_([a-f0-9]{16})_([A-Za-z0-9_-]{43})$/;

async function withTenant(id = "acme", plan = "free") {
  const redis = createMemoryRedis();
  await createTenant(redis, { id, name: "Acme Inc", plan });
  return redis;
}

/** Every stored value, flattened, for "secret never at rest" checks. */
function allStored(redis) {
  const out = [];
  for (const [k, e] of redis._data) {
    out.push(k);
    if (e.type === "string") out.push(e.value);
    else if (e.type === "hash") for (const [f, v] of e.value) out.push(f, v);
    else out.push(...e.value);
  }
  return out.join("\n");
}

// ---------- ids ----------

test("validTenantId: format and reserved ids", () => {
  assert.deepEqual(RESERVED, ["madez", "cloud", "probe", "admin", "system"]);
  for (const id of ["acme", "abc", "a-1", "x".repeat(31), "team-42"]) assert.equal(validTenantId(id), true, id);
  for (const id of [...RESERVED, "ab", "1abc", "-abc", "Acme", "acme_x", "acme:x", "a".repeat(32), "", null, undefined, 42, "acme\n", "ac me", "acmi:madez"]) {
    assert.equal(validTenantId(id), false, String(id));
  }
});

test("createTenant: refuses reserved and malformed ids, writes nothing", async () => {
  const redis = createMemoryRedis();
  for (const id of [...RESERVED, "A", "x:y", "../etc"]) {
    await assert.rejects(createTenant(redis, { id, plan: "free" }), (e) => e.code === "invalid_tenant" && !e.message.includes(id));
  }
  assert.equal(redis._data.size, 0);
});

// ---------- registry ----------

test("createTenant: registry hash + set, defaults, alias plans", async () => {
  const redis = createMemoryRedis();
  const t = await createTenant(redis, { id: "acme", name: "Acme Inc", plan: "pro" });
  assert.equal(t.id, "acme");
  assert.equal(t.status, "active");
  assert.equal(t.plan, "pro");
  assert.equal(t.namespace, "acmi:acme:");
  assert.deepEqual(t.key_ids, []);
  assert.equal(await redis("TYPE", "acmi:cloud:tenant:acme"), "hash");
  assert.deepEqual(await redis("SMEMBERS", "acmi:cloud:tenants"), ["acme"]);
  assert.deepEqual(await getTenant(redis, "acme"), t);

  const d = await createTenant(redis, { id: "beta" });
  assert.equal(d.plan, loadPlans().default);
  assert.equal(d.name, "beta");
  assert.equal((await createTenant(redis, { id: "gamma", plan: "starter" })).plan, "dev", "PRD alias");
  assert.equal((await createTenant(redis, { id: "delta", plan: "scale" })).plan, "agency", "PRD alias");
  await assert.rejects(createTenant(redis, { id: "eps", plan: "platinum" }), { code: "unknown_plan" });
  await assert.rejects(createTenant(redis, { id: "eps", plan: "_note" }), { code: "unknown_plan" });
  await assert.rejects(createTenant(redis, { id: "eps", name: "" }), { code: "invalid_name" });
  await assert.rejects(createTenant(redis, { id: "eps", name: "x\u0000y" }), { code: "invalid_name" });
  assert.equal(await getTenant(redis, "eps"), null);
  assert.deepEqual((await listTenants(redis)).map((x) => x.id), ["acme", "beta", "delta", "gamma"]);
});

test("createTenant: duplicate create does not overwrite", async () => {
  const redis = createMemoryRedis();
  const first = await createTenant(redis, { id: "acme", name: "Original", plan: "pro" });
  await assert.rejects(createTenant(redis, { id: "acme", name: "Hijack", plan: "free" }), { code: "tenant_exists" });
  const now = await getTenant(redis, "acme");
  assert.equal(now.name, "Original");
  assert.equal(now.plan, "pro");
  assert.equal(now.created_at, first.created_at);

  // Concurrent creates: exactly one wins.
  const r = await Promise.allSettled([1, 2, 3, 4].map((i) => createTenant(redis, { id: "race", name: `n${i}` })));
  assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
});

test("createTenant: a half-written tenant is completed without overwriting; verify stays fail-closed until then", async () => {
  const redis = createMemoryRedis();
  const keyid = "ab".repeat(8);
  const secret = "A".repeat(43);
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  await redis("HSET", "acmi:cloud:tenant:acme", "id", "acme", "name", "Original", "plan", "pro");
  await redis("HSET", `acmi:cloud:key:${keyid}`, "keyid", keyid, "tenant", "acme", "hash", hash, "created_at", "1");
  const presented = `acmi_live_${keyid}_${secret}`;
  assert.equal((await getTenant(redis, "acme")).status, "suspended", "missing status reads as suspended");
  assert.equal(await verifyKey(redis, presented), null, "verify fail-closed on a half tenant");

  const repaired = await createTenant(redis, { id: "acme", name: "Hijack", plan: "free" });
  assert.equal(repaired.name, "Original", "a stored name is not overwritten");
  assert.equal(repaired.plan, "pro", "a stored plan is not overwritten");
  assert.equal(repaired.status, "active");
  assert.equal(repaired.namespace, "acmi:acme:");
  assert.deepEqual(repaired.key_ids, []);
  assert.deepEqual(await redis("SMEMBERS", "acmi:cloud:tenants"), ["acme"]);
  assert.deepEqual(await verifyKey(redis, presented), { tenant: "acme", keyid });
  await assert.rejects(createTenant(redis, { id: "acme", name: "Hijack", plan: "free" }), { code: "tenant_exists" });
  assert.equal((await getTenant(redis, "acme")).name, "Original");

  // Claim only: the retry supplies the fields that were never written.
  await redis("HSET", "acmi:cloud:tenant:beta", "id", "beta");
  const beta = await createTenant(redis, { id: "beta", name: "Beta Co", plan: "dev" });
  assert.equal(beta.name, "Beta Co");
  assert.equal(beta.plan, "dev");
  assert.equal(beta.status, "active");
  assert.ok(beta.created_at > 0);

  // Complete record missing only the set membership: rejoin, do not rewrite.
  await redis("SREM", "acmi:cloud:tenants", "acme");
  const again = await createTenant(redis, { id: "acme", name: "Hijack", plan: "free" });
  assert.equal(again.name, "Original");
  assert.equal(again.created_at, repaired.created_at);
  assert.deepEqual(await redis("SMEMBERS", "acmi:cloud:tenants"), ["acme", "beta"]);

  await setStatus(redis, "beta", "deleted");
  await assert.rejects(createTenant(redis, { id: "beta", name: "Back", plan: "free" }), { code: "tenant_exists" });
  assert.equal((await getTenant(redis, "beta")).status, "deleted", "a deleted tenant is not repaired back to active");
});

test("getTenant / setStatus: validation, transitions, deleted is terminal", async () => {
  const redis = await withTenant();
  assert.equal(await getTenant(redis, "nope"), null);
  assert.equal(await getTenant(redis, "madez"), null);
  assert.equal(await getTenant(redis, "acme:x"), null);
  assert.equal((await setStatus(redis, "acme", "suspended")).status, "suspended");
  assert.equal((await getTenant(redis, "acme")).status, "suspended");
  assert.equal((await setStatus(redis, "acme", "active")).status, "active");
  await assert.rejects(setStatus(redis, "acme", "paused"), { code: "invalid_status" });
  await assert.rejects(setStatus(redis, "ghost", "active"), { code: "not_found" });
  await assert.rejects(setStatus(redis, "ADMIN", "active"), { code: "invalid_tenant" });
  await setStatus(redis, "acme", "deleted");
  await assert.rejects(setStatus(redis, "acme", "active"), { code: "invalid_status" });
});

// ---------- plans ----------

test("plans.json: PRICING.md ladder, recall placeholders flagged, aliases", () => {
  const raw = JSON.parse(readFileSync(new URL("../cloud/plans.json", import.meta.url), "utf8"));
  assert.match(raw._note, /Mikey to confirm/);
  const doc = loadPlans();
  assert.deepEqual(Object.keys(doc.plans), ["free", "dev", "pro", "team", "agency", "enterprise"]);
  const want = { free: [0, 10000, 7], dev: [19, 50000, 30], pro: [49, 150000, 90], team: [99, 500000, 365], agency: [199, 1500000, 365] };
  for (const [id, [price, adds, days]] of Object.entries(want)) {
    const p = doc.plans[id];
    assert.equal(p.price_usd_month, price, id);
    assert.equal(p.limits.add, adds, id);
    assert.equal(p.limits.read, null, `${id}: reads unmetered for quota`);
    assert.ok(Number.isInteger(p.limits.recall), id);
    assert.match(p._note, /Mikey to confirm/, id);
    assert.equal(p.history_days, days, id);
    assert.ok("spaces" in p && "agents" in p, id);
  }
  assert.deepEqual(doc.plans.enterprise.limits, { add: null, read: null, recall: null });
  assert.equal(doc.plans.free.overage, null);
  assert.equal(doc.plans.dev.overage, null);
  for (const id of ["pro", "team", "agency", "enterprise"]) assert.equal(doc.plans[id].overage.billed, true, id);
  assert.ok(Object.isFrozen(doc) && Object.isFrozen(doc.plans.free.limits), "plans are immutable at runtime");
});

test("planFor: tenant record or name, aliases, unknown fails closed", () => {
  assert.equal(planFor({ id: "acme", plan: "pro" }).limits.add, 150000);
  assert.equal(planFor("pro").id, "pro");
  assert.equal(planFor("starter").id, "dev");
  assert.equal(planFor("scale").id, "agency");
  assert.equal(planFor("free").grace_ratio, 0.1);
  for (const bad of ["nope", "", null, undefined, {}, { plan: "__proto__" }, "constructor", "_note"]) {
    assert.throws(() => planFor(bad), { code: "unknown_plan" });
  }
});

// ---------- keys ----------

test("createKey: format, 32-byte base64url secret, only sha256 stored", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme", { label: "ci" });
  const m = key.match(KEY_RE);
  assert.ok(m, "acmi_live_<keyid>_<secret>");
  assert.equal(m[1], keyid);
  assert.equal(Buffer.from(m[2], "base64url").length, 32);
  const stored = allStored(redis);
  assert.ok(!stored.includes(m[2]), "secret never at rest");
  assert.ok(!stored.includes(key), "full key never at rest");
  const h = await redis("HGET", `acmi:cloud:key:${keyid}`, "hash");
  assert.equal(h, crypto.createHash("sha256").update(m[2]).digest("hex"));
  assert.deepEqual((await getTenant(redis, "acme")).key_ids, [keyid]);

  const two = await createKey(redis, "acme");
  assert.notEqual(two.keyid, keyid);
  assert.notEqual(two.key, key);
  await assert.rejects(createKey(redis, "ghost"), { code: "not_found" });
  await assert.rejects(createKey(redis, "madez"), { code: "invalid_tenant" });
  await assert.rejects(createKey(redis, "acme", { label: "x".repeat(65) }), { code: "invalid_label" });
  await assert.rejects(createKey(redis, "acme", { label: "a\nb" }), { code: "invalid_label" });
});

test("verifyKey: happy path and every malformed / wrong input returns null", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  assert.deepEqual(await verifyKey(redis, key), { tenant: "acme", keyid });
  const [, , secret] = key.match(KEY_RE);
  const flip = secret[0] === "A" ? "B" : "A";
  const bad = [
    `acmi_live_${keyid}_${flip}${secret.slice(1)}`, // wrong secret
    `acmi_live_${"0".repeat(16)}_${secret}`, // unknown keyid
    `acmi_test_${keyid}_${secret}`,
    `acmi_live_${keyid.toUpperCase()}_${secret}`,
    `${key}x`,
    key.slice(0, -1),
    ` ${key}`,
    `acmi_live_${keyid}_${secret.slice(0, 42)}=`,
    "",
    null,
    undefined,
    42,
    { key },
  ];
  for (const b of bad) assert.equal(await verifyKey(redis, b), null, String(b).slice(0, 20));
});

test("verifyKey: uses crypto.timingSafeEqual on hash buffers, even on a miss", async () => {
  const redis = await withTenant();
  const { key } = await createKey(redis, "acme");
  const spy = mock.method(crypto, "timingSafeEqual");
  try {
    await verifyKey(redis, key);
    await verifyKey(redis, `acmi_live_${"0".repeat(16)}_${"A".repeat(43)}`);
    await verifyKey(redis, "garbage");
    assert.equal(spy.mock.callCount(), 3, "one constant-time compare per call, hit or miss");
    for (const c of spy.mock.calls) {
      assert.ok(Buffer.isBuffer(c.arguments[0]) && Buffer.isBuffer(c.arguments[1]));
      assert.equal(c.arguments[0].length, 32);
      assert.equal(c.arguments[1].length, 32);
    }
  } finally {
    spy.mock.restore();
  }
});

test("verifyKey: refused after revoke", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  const other = await createKey(redis, "acme");
  const r = await revokeKey(redis, "acme", keyid);
  assert.equal(r.status, "revoked");
  assert.equal(await verifyKey(redis, key), null);
  assert.deepEqual(await verifyKey(redis, other.key), { tenant: "acme", keyid: other.keyid }, "other keys unaffected");
  const again = await revokeKey(redis, "acme", keyid);
  assert.equal(again.revoked_at, r.revoked_at, "revoke is idempotent");
  await assert.rejects(rotateKey(redis, "acme", keyid), { code: "not_found" }, "cannot rotate a revoked key");
});

test("revokeKey / rotateKey: cannot touch another tenant's key; ids validated", async () => {
  const redis = await withTenant();
  await createTenant(redis, { id: "beta" });
  const a = await createKey(redis, "acme");
  await assert.rejects(revokeKey(redis, "beta", a.keyid), { code: "not_found" });
  await assert.rejects(rotateKey(redis, "beta", a.keyid), { code: "not_found" });
  await assert.rejects(revokeKey(redis, "acme", "not-a-key"), { code: "invalid_key" });
  await assert.rejects(revokeKey(redis, "acme", "*"), { code: "invalid_key" });
  await assert.rejects(revokeKey(redis, "acme", "0".repeat(16)), { code: "not_found" });
  await assert.rejects(revokeKey(redis, "cloud", a.keyid), { code: "invalid_tenant" });
  assert.deepEqual(await verifyKey(redis, a.key), { tenant: "acme", keyid: a.keyid });
});

test("rotateKey: old key valid during grace, refused after", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 13) });
  const redis = await withTenant();
  const old = await createKey(redis, "acme", { label: "prod" });
  const r = await rotateKey(redis, "acme", old.keyid, { graceMs: 60000 });
  assert.match(r.key, KEY_RE);
  assert.notEqual(r.keyid, old.keyid);
  assert.equal(r.previous, old.keyid);
  assert.equal(r.previous_expires_at, Date.UTC(2026, 9, 13) + 60000);

  assert.deepEqual(await verifyKey(redis, old.key), { tenant: "acme", keyid: old.keyid }, "inside grace");
  assert.deepEqual(await verifyKey(redis, r.key), { tenant: "acme", keyid: r.keyid });
  t.mock.timers.tick(59999);
  assert.ok(await verifyKey(redis, old.key), "1 ms before grace end");
  t.mock.timers.tick(1);
  assert.equal(await verifyKey(redis, old.key), null, "grace over");
  assert.ok(await verifyKey(redis, r.key), "new key still valid");

  const keys = await listKeys(redis, "acme");
  const o = keys.find((k) => k.keyid === old.keyid);
  assert.equal(o.status, "expired");
  assert.equal(o.rotated_to, r.keyid);
  assert.equal(keys.find((k) => k.keyid === r.keyid).label, "prod", "label carried over");
  await assert.rejects(rotateKey(redis, "acme", old.keyid), { code: "not_found" }, "expired key cannot rotate");
});

test("rotateKey: default grace is 24h; graceMs 0 cuts off now; bad grace refused", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const redis = await withTenant();
  const a = await createKey(redis, "acme");
  const r = await rotateKey(redis, "acme", a.keyid);
  assert.equal(r.previous_expires_at, 1_800_000_000_000 + 86400000);
  const b = await createKey(redis, "acme");
  await rotateKey(redis, "acme", b.keyid, { graceMs: 0 });
  assert.equal(await verifyKey(redis, b.key), null);
  for (const graceMs of [-1, 1.5, "60000", Number.POSITIVE_INFINITY, 31 * 86400000]) {
    await assert.rejects(rotateKey(redis, "acme", r.keyid, { graceMs }), { code: "invalid_grace" });
  }
  // Rotating a key already in grace never extends its life.
  const c = await createKey(redis, "acme");
  const c1 = await rotateKey(redis, "acme", c.keyid, { graceMs: 1000 });
  const c2 = await rotateKey(redis, "acme", c.keyid, { graceMs: 86400000 });
  assert.equal(c2.previous_expires_at, c1.previous_expires_at);
});

test("verifyKey: suspended and deleted tenants are refused; resume restores", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  await setStatus(redis, "acme", "suspended");
  assert.equal(await verifyKey(redis, key), null);
  await setStatus(redis, "acme", "active");
  assert.deepEqual(await verifyKey(redis, key), { tenant: "acme", keyid });
  await setStatus(redis, "acme", "deleted");
  assert.equal(await verifyKey(redis, key), null);
  await assert.rejects(createKey(redis, "acme"), { code: "not_found" });
  await assert.rejects(rotateKey(redis, "acme", keyid), { code: "not_found" });
});

test("createKey / rotateKey: a suspended tenant is refused", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  await setStatus(redis, "acme", "suspended");
  const created = await createKey(redis, "acme").catch((e) => e);
  const rotated = await rotateKey(redis, "acme", keyid).catch((e) => e);
  assert.equal(created.code, "tenant_suspended");
  assert.equal(rotated.code, "tenant_suspended");
  assert.equal(created.message, "tenant_suspended", "fixed code, no tenant id in the message");
  assert.ok(!created.message.includes("acme") && !rotated.message.includes("acme"));
  assert.equal(await verifyKey(redis, key), null);
  await setStatus(redis, "acme", "active");
  const next = await rotateKey(redis, "acme", keyid, { graceMs: 0 });
  assert.match(next.key, KEY_RE);
});

test("verifyKey: a key record pointing at a reserved or missing tenant is refused", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  await redis("HSET", `acmi:cloud:key:${keyid}`, "tenant", "madez");
  assert.equal(await verifyKey(redis, key), null);
  await redis("HSET", `acmi:cloud:key:${keyid}`, "tenant", "ghost");
  assert.equal(await verifyKey(redis, key), null);
});

test("listKeys: metadata only, never hashes or secrets", async () => {
  const redis = await withTenant();
  await createTenant(redis, { id: "beta" });
  const a = await createKey(redis, "acme", { label: "one" });
  const b = await createKey(redis, "acme", { label: "two" });
  await createKey(redis, "beta");
  await revokeKey(redis, "acme", b.keyid);
  const keys = await listKeys(redis, "acme");
  assert.deepEqual(keys.map((k) => k.keyid).sort(), [a.keyid, b.keyid].sort(), "only this tenant's keys");
  const allowed = new Set(["keyid", "label", "status", "created_at", "prefix", "expires_at", "rotated_to", "revoked_at"]);
  for (const k of keys) {
    for (const f of Object.keys(k)) assert.ok(allowed.has(f), `unexpected field ${f}`);
    assert.equal(k.prefix, `acmi_live_${k.keyid}_`);
  }
  const text = JSON.stringify(keys);
  for (const { keyid, key } of [a, b]) {
    const h = await redis("HGET", `acmi:cloud:key:${keyid}`, "hash");
    assert.ok(!text.includes(h), "no hash in listing");
    assert.ok(!text.includes(key.split("_").slice(3).join("_")), "no secret in listing");
  }
  assert.equal(keys.find((k) => k.keyid === b.keyid).status, "revoked");
  assert.equal(keys.find((k) => k.keyid === a.keyid).status, "active");
  assert.deepEqual(await listKeys(redis, "ghost"), []);
  await assert.rejects(listKeys(redis, "system"), { code: "invalid_tenant" });
});

test("no API surface returns a secret twice; errors never echo input", async () => {
  const redis = await withTenant();
  const { key, keyid } = await createKey(redis, "acme");
  const secret = key.slice(`acmi_live_${keyid}_`.length);
  const surfaces = [
    await getTenant(redis, "acme"),
    await listTenants(redis),
    await listKeys(redis, "acme"),
    await verifyKey(redis, key),
    await revokeKey(redis, "acme", keyid),
  ];
  assert.ok(!JSON.stringify(surfaces).includes(secret));
  const e = await createTenant(redis, { id: secret.toLowerCase() }).catch((x) => x);
  assert.ok(e instanceof Error && !e.message.includes(secret.toLowerCase()));
});
