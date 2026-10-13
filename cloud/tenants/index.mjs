// cloud/tenants — ACMI Cloud control plane: tenant registry, API keys, plans.
//
// Spec: docs/cloud/BACKPLANE.md §1. Works over any Redis command runner with the
// `await redis("HSET", key, ...)` shape (memory, REST, native).
//
// Keys:
//   acmi:cloud:tenants              SET of tenant ids
//   acmi:cloud:tenant:{id}          HASH id, name, plan, status, created_at, namespace, key_ids (JSON),
//                                   updated_at, deleted_at (write-once; present = deleted, whatever status says)
//   acmi:cloud:tenant:{id}:keys     SET of key ids (authoritative; key_ids mirrors it)
//   acmi:cloud:key:{keyid}          HASH keyid, tenant, label, hash, created_at, expires_at, revoked_at, rotated_to
//   acmi:cloud:key:{keyid}:expiry   ZSET member "at", written with ZADD LT (write-if-lower): the authoritative
//                                   rotate-grace end; concurrent rotations can only shorten it
//
// Tenant data lives under namespaceFor(id) = "t-{id}", i.e. acmi:t-{id}: and lm:t-{id}: (BACKPLANE.md Rule 4).
// The Qdrant tenant_id is the bare id.
//
// Secrets: an API key is `acmi_live_<keyid>_<secret>`, secret = 32 random bytes,
// base64url. Only sha256(secret) is stored. The full key is returned exactly once
// (createKey / rotateKey) and never logged. Errors are generic and never echo input.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { registerEvalScript } from "../../src/lib/lua-scripts.mjs";

// Defence in depth on top of the t- namespace (BACKPLANE.md §1, PR #28 review M1).
export const RESERVED = [
  "madez", "cloud", "probe", "admin", "system", "agent", "work", "thread", "bus", "user", "oauth", "onboard",
  "fieldnotes", "registry", "tenant", "inbox", "relay", "acmi", "lm", "logmem", "mcp", "api", "www", "t",
];
export const STATUSES = ["active", "suspended", "deleted"];

const TENANT_RE = /^[a-z][a-z0-9-]{2,30}$/;
const KEYID_RE = /^[a-f0-9]{16}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const KEY_PREFIX = "acmi_live_";
const MAX_KEY_LEN = KEY_PREFIX.length + 16 + 1 + 43;
const MAX_GRACE_MS = 30 * 86400000;
export const MAX_LIVE_KEYS = 20; // active + in-grace keys per tenant

const TENANTS_SET = "acmi:cloud:tenants";
const tenantKey = (id) => `acmi:cloud:tenant:${id}`;
const tenantKeysSet = (id) => `acmi:cloud:tenant:${id}:keys`;
const keyKey = (keyid) => `acmi:cloud:key:${keyid}`;
const keyExpiryKey = (keyid) => `acmi:cloud:key:${keyid}:expiry`;

/** Generic error: a fixed message and code, never the offending value. */
function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

export function validTenantId(id) {
  return typeof id === "string" && TENANT_RE.test(id) && !RESERVED.includes(id);
}

/** Redis namespace segment for a tenant: "t-{id}". Never build it by hand. */
export function namespaceFor(id) {
  if (!validTenantId(id)) throw fail("invalid_tenant");
  return `t-${id}`;
}

/** The only key prefixes a tenant credential may touch. */
export function keyPrefixes(id) {
  const ns = namespaceFor(id);
  return [`acmi:${ns}:`, `lm:${ns}:`];
}

export function validKeyId(keyid) {
  return typeof keyid === "string" && KEYID_RE.test(keyid);
}

function hashToObj(arr) {
  const out = {};
  for (let i = 0; i < (arr || []).length; i += 2) out[arr[i]] = arr[i + 1];
  return out;
}

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest();

// ---------- plans ----------

let plansCache = null;

function deepFreeze(o) {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const OPS = ["add", "read", "recall"];

function checkPlans(doc) {
  if (!doc || typeof doc !== "object" || !doc.plans || typeof doc.plans !== "object") throw fail("invalid_plans");
  for (const [id, p] of Object.entries(doc.plans)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || !p || typeof p.limits !== "object") throw fail("invalid_plans");
    for (const op of OPS) {
      const v = p.limits[op];
      if (v !== null && !(Number.isSafeInteger(v) && v >= 0)) throw fail("invalid_plans");
    }
  }
  if (!doc.plans[doc.default]) throw fail("invalid_plans");
  if (doc.grace_ratio !== undefined && !(Number.isFinite(doc.grace_ratio) && doc.grace_ratio >= 0 && doc.grace_ratio <= 1)) {
    throw fail("invalid_plans");
  }
  for (const [alias, target] of Object.entries(doc.aliases || {})) {
    if (!alias.startsWith("_") && !doc.plans[target]) throw fail("invalid_plans");
  }
  return doc;
}

/** Read cloud/plans.json (cached after first load; restart to pick up edits). */
export function loadPlans() {
  if (!plansCache) {
    const text = readFileSync(new URL("../plans.json", import.meta.url), "utf8");
    plansCache = deepFreeze(checkPlans(JSON.parse(text)));
  }
  return plansCache;
}

function resolvePlanId(name) {
  const doc = loadPlans();
  if (typeof name !== "string" || name.startsWith("_")) return null;
  if (Object.hasOwn(doc.plans, name)) return name;
  const aliased = doc.aliases && Object.hasOwn(doc.aliases, name) ? doc.aliases[name] : null;
  return aliased && Object.hasOwn(doc.plans, aliased) ? aliased : null;
}

/**
 * Plan object for a tenant record (`{plan}`) or a plan name. Aliases resolve
 * (starter -> dev, scale -> agency). Returns `{id, ...plan, grace_ratio}`.
 * Throws `unknown_plan` rather than guessing: quotas fail closed.
 */
export function planFor(tenant) {
  const name = typeof tenant === "string" ? tenant : tenant?.plan;
  const id = resolvePlanId(name);
  if (!id) throw fail("unknown_plan");
  const doc = loadPlans();
  return Object.freeze({ id, ...doc.plans[id], grace_ratio: doc.grace_ratio ?? 0.1 });
}

// ---------- tenants ----------

function toTenant(h) {
  // A half-written record (no status) reads as suspended: fail closed until createTenant completes it.
  if (!h || !h.id) return null;
  let keyIds = [];
  try {
    const v = JSON.parse(h.key_ids || "[]");
    if (Array.isArray(v)) keyIds = v.filter(validKeyId);
  } catch {
    keyIds = [];
  }
  const t = {
    id: h.id,
    name: h.name ?? h.id,
    plan: h.plan,
    status: h.deleted_at ? "deleted" : STATUSES.includes(h.status) ? h.status : "suspended",
    created_at: Number(h.created_at) || 0,
    namespace: h.namespace,
    key_ids: keyIds,
  };
  if (h.updated_at) t.updated_at = Number(h.updated_at);
  if (h.bridge_port) t.bridge_port = Number(h.bridge_port);
  if (h.deleted_at) t.deleted_at = Number(h.deleted_at);
  return t;
}

// One Redis EVAL. A crash cannot leave a claimed id with the rest of the hash
// unwritten: the script either creates the whole record, fills fields that a
// crashed create never wrote (without overwriting ones it did), or reports
// that a complete tenant already exists. A missing status still reads as
// suspended, so verify stays fail-closed until this script finishes.
export const CREATE_TENANT_LUA = `
local key = KEYS[1]
local setkey = KEYS[2]
local id = ARGV[1]
local name = ARGV[2]
local plan = ARGV[3]
local now = ARGV[4]
local namespace = ARGV[5]
local function field(f)
  local v = redis.call("HGET", key, f)
  if v == false or v == "" then return nil end
  return v
end
local existing = field("id")
if not existing then
  redis.call("HSET", key, "id", id, "name", name, "plan", plan, "status", "active", "created_at", now, "namespace", namespace, "key_ids", "[]")
  redis.call("SADD", setkey, id)
  return "created"
end
if existing ~= id then return "exists" end
local half = (not field("name")) or (not field("plan")) or (not field("status")) or (not field("created_at")) or (not field("namespace")) or (not field("key_ids"))
local inset = redis.call("SISMEMBER", setkey, id) == 1
if not half then
  if (not inset) and field("status") == "active" then
    redis.call("SADD", setkey, id)
    return "repaired"
  end
  return "exists"
end
if not field("name") then redis.call("HSET", key, "name", name) end
if not field("plan") then redis.call("HSET", key, "plan", plan) end
if not field("status") then redis.call("HSET", key, "status", "active") end
if not field("created_at") then redis.call("HSET", key, "created_at", now) end
if not field("namespace") then redis.call("HSET", key, "namespace", namespace) end
if not field("key_ids") then redis.call("HSET", key, "key_ids", "[]") end
redis.call("SADD", setkey, id)
return "repaired"
`;

// Same steps as CREATE_TENANT_LUA. memory-redis runs this; a real Redis runs the script.
function applyCreateTenant(call, keys, argv) {
  const [key, setkey] = keys;
  const [id, name, plan, now, namespace] = argv;
  const field = (f) => {
    const v = call("HGET", key, f);
    if (v == null || v === false || v === "") return null;
    return String(v);
  };
  const existing = field("id");
  if (!existing) {
    call("HSET", key, "id", id, "name", name, "plan", plan, "status", "active", "created_at", now, "namespace", namespace, "key_ids", "[]");
    call("SADD", setkey, id);
    return "created";
  }
  if (existing !== id) return "exists";
  const half = ["name", "plan", "status", "created_at", "namespace", "key_ids"].some((f) => !field(f));
  const inset = Number(call("SISMEMBER", setkey, id)) === 1;
  if (!half) {
    if (!inset && field("status") === "active") {
      call("SADD", setkey, id);
      return "repaired";
    }
    return "exists";
  }
  if (!field("name")) call("HSET", key, "name", name);
  if (!field("plan")) call("HSET", key, "plan", plan);
  if (!field("status")) call("HSET", key, "status", "active");
  if (!field("created_at")) call("HSET", key, "created_at", now);
  if (!field("namespace")) call("HSET", key, "namespace", namespace);
  if (!field("key_ids")) call("HSET", key, "key_ids", "[]");
  call("SADD", setkey, id);
  return "repaired";
}

registerEvalScript(CREATE_TENANT_LUA, applyCreateTenant);

/** Create a tenant once. A second create of a complete tenant fails and changes nothing. A half-written tenant is completed without overwriting fields already stored. */
export async function createTenant(redis, { id, name, plan } = {}) {
  if (!validTenantId(id)) throw fail("invalid_tenant");
  const planId = resolvePlanId(plan ?? loadPlans().default);
  if (!planId) throw fail("unknown_plan");
  const display = name === undefined ? id : name;
  if (typeof display !== "string" || display.length < 1 || display.length > 100 || /[\u0000-\u001f\u007f]/.test(display)) {
    throw fail("invalid_name");
  }
  const result = await redis(
    "EVAL", CREATE_TENANT_LUA, 2,
    tenantKey(id), TENANTS_SET,
    id, display, planId, String(Date.now()), namespaceFor(id),
  );
  if (result !== "created" && result !== "repaired") throw fail("tenant_exists");
  const stored = await getTenant(redis, id);
  if (!stored) throw fail("tenant_exists");
  return stored;
}

export async function getTenant(redis, id) {
  if (!validTenantId(id)) return null;
  return toTenant(hashToObj(await redis("HGETALL", tenantKey(id))));
}

export async function listTenants(redis) {
  const ids = (await redis("SMEMBERS", TENANTS_SET)) || [];
  const out = [];
  for (const id of [...ids].sort()) {
    const t = await getTenant(redis, id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * active | suspended | deleted. Deletion is final, also under concurrency:
 * delete writes a write-once deleted_at (HSETNX) that toTenant honours over
 * status; every other change re-checks deleted_at after its write and puts
 * status back to deleted if a delete landed meanwhile.
 */
export async function setStatus(redis, id, status) {
  if (!validTenantId(id)) throw fail("invalid_tenant");
  if (!STATUSES.includes(status)) throw fail("invalid_status");
  const t = await getTenant(redis, id);
  if (!t) throw fail("not_found");
  const key = tenantKey(id);
  const now = Date.now();
  if (status === "deleted") {
    await redis("HSETNX", key, "deleted_at", String(now));
    await redis("HSET", key, "status", "deleted", "updated_at", String(now));
    const at = Number(await redis("HGET", key, "deleted_at"));
    return { ...t, status: "deleted", updated_at: now, deleted_at: at };
  }
  if (t.status === "deleted") throw fail("invalid_status");
  await redis("HSET", key, "status", status, "updated_at", String(now));
  if (await redis("HGET", key, "deleted_at")) {
    await redis("HSET", key, "status", "deleted");
    throw fail("invalid_status");
  }
  return { ...t, status, updated_at: now };
}

// ---------- API keys ----------

function parseKey(presented) {
  if (typeof presented !== "string" || presented.length !== MAX_KEY_LEN || !presented.startsWith(KEY_PREFIX)) return null;
  const rest = presented.slice(KEY_PREFIX.length);
  const keyid = rest.slice(0, 16);
  if (rest[16] !== "_") return null;
  const secret = rest.slice(17);
  if (!validKeyId(keyid) || !SECRET_RE.test(secret)) return null;
  return { keyid, secret };
}

async function syncKeyIds(redis, tenant) {
  const ids = ((await redis("SMEMBERS", tenantKeysSet(tenant))) || []).filter(validKeyId).sort();
  await redis("HSET", tenantKey(tenant), "key_ids", JSON.stringify(ids));
  return ids;
}

async function readKey(redis, keyid) {
  const h = hashToObj(await redis("HGETALL", keyKey(keyid)));
  if (!h.keyid) return null;
  // The ZSET (write-if-lower) is authoritative; the hash field is a mirror.
  const z = (await redis("ZRANGE", keyExpiryKey(keyid), 0, 0, "WITHSCORES")) || [];
  const zAt = z.length >= 2 ? Number(z[1]) : NaN;
  const hAt = h.expires_at ? Number(h.expires_at) : NaN;
  const at = Math.min(Number.isFinite(zAt) ? zAt : Infinity, Number.isFinite(hAt) ? hAt : Infinity);
  if (Number.isFinite(at)) h.expires_at = String(at);
  else delete h.expires_at;
  return h;
}

function keyState(k, now = Date.now()) {
  if (k.revoked_at) return "revoked";
  if (k.expires_at && Number(k.expires_at) <= now) return "expired";
  return "active";
}

function validLabel(label) {
  return typeof label === "string" && label.length <= 64 && !/[\u0000-\u001f\u007f]/.test(label);
}

async function liveKeyCount(redis, tenant, excluding) {
  const ids = ((await redis("SMEMBERS", tenantKeysSet(tenant))) || []).filter(validKeyId);
  const now = Date.now();
  let n = 0;
  for (const id of ids) {
    if (id === excluding) continue;
    const k = await readKey(redis, id);
    if (k && k.tenant === tenant && keyState(k, now) === "active") n++;
  }
  return n;
}

async function mintKey(redis, tenant, label, { excluding } = {}) {
  if ((await liveKeyCount(redis, tenant, excluding)) >= MAX_LIVE_KEYS) throw fail("key_limit");
  let keyid;
  for (let i = 0; i < 4 && !keyid; i++) {
    const candidate = crypto.randomBytes(8).toString("hex");
    if (Number(await redis("HSETNX", keyKey(candidate), "keyid", candidate)) === 1) keyid = candidate;
  }
  if (!keyid) throw fail("key_create_failed");
  const secret = crypto.randomBytes(32).toString("base64url");
  await redis(
    "HSET", keyKey(keyid),
    "tenant", tenant,
    "label", label,
    "hash", sha256(secret).toString("hex"),
    "created_at", String(Date.now()),
  );
  await redis("SADD", tenantKeysSet(tenant), keyid);
  await syncKeyIds(redis, tenant);
  return { key: `${KEY_PREFIX}${keyid}_${secret}`, keyid };
}

/** Create an API key. The returned `key` is the only copy; store it now. */
export async function createKey(redis, tenant, { label = "" } = {}) {
  if (!validTenantId(tenant)) throw fail("invalid_tenant");
  if (!validLabel(label)) throw fail("invalid_label");
  const t = await getTenant(redis, tenant);
  if (!t || t.status === "deleted") throw fail("not_found");
  if (t.status !== "active") throw fail("tenant_suspended");
  return mintKey(redis, tenant, label);
}

// Fixed dummy so a miss costs the same hash + compare as a hit.
const DUMMY_HASH = sha256("acmi-dummy-key-hash");

/**
 * Verify a presented key. Returns `{tenant, keyid}` or null; never says why.
 * Refuses: malformed, unknown, revoked, expired (rotate grace over), tenant
 * missing / suspended / deleted.
 */
export async function verifyKey(redis, presented) {
  const parsed = parseKey(presented);
  const got = sha256(parsed ? parsed.secret : "acmi-malformed");
  const k = parsed ? await readKey(redis, parsed.keyid) : null;
  let want = DUMMY_HASH;
  if (k && /^[a-f0-9]{64}$/.test(k.hash || "")) want = Buffer.from(k.hash, "hex");
  const match = crypto.timingSafeEqual(want, got);
  if (!parsed || !k || !match || want === DUMMY_HASH) return null;
  if (k.keyid !== parsed.keyid || keyState(k) !== "active") return null;
  if (!validTenantId(k.tenant)) return null;
  // Defence in depth: the tenant field must agree with the tenant's own key set.
  if (Number(await redis("SISMEMBER", tenantKeysSet(k.tenant), k.keyid)) !== 1) return null;
  const t = await getTenant(redis, k.tenant);
  if (!t || t.status !== "active") return null;
  return { tenant: k.tenant, keyid: k.keyid };
}

async function ownedKey(redis, tenant, keyid) {
  if (!validTenantId(tenant)) throw fail("invalid_tenant");
  if (!validKeyId(keyid)) throw fail("invalid_key");
  const k = await readKey(redis, keyid);
  if (!k || k.tenant !== tenant) throw fail("not_found");
  return k;
}

/**
 * Issue a new key with the same label. The old key stays valid until
 * now + graceMs, then verifyKey refuses it. graceMs 0 cuts it off immediately.
 */
export async function rotateKey(redis, tenant, keyid, { graceMs = 86400000 } = {}) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS) throw fail("invalid_grace");
  const old = await ownedKey(redis, tenant, keyid);
  if (keyState(old) !== "active") throw fail("not_found");
  const t = await getTenant(redis, tenant);
  if (!t || t.status === "deleted") throw fail("not_found");
  if (t.status !== "active") throw fail("tenant_suspended");
  const next = await mintKey(redis, tenant, old.label ?? "", { excluding: keyid });
  const until = Date.now() + graceMs;
  // Write-if-lower: ZADD LT can only shorten the grace, whatever the interleaving.
  await redis("ZADD", keyExpiryKey(keyid), "LT", until, "at");
  const z = (await redis("ZRANGE", keyExpiryKey(keyid), 0, 0, "WITHSCORES")) || [];
  const expiresAt = Math.min(Number(z[1]) || until, until);
  await redis("HSET", keyKey(keyid), "expires_at", String(expiresAt), "rotated_to", next.keyid);
  return { key: next.key, keyid: next.keyid, previous: keyid, previous_expires_at: expiresAt };
}

export async function revokeKey(redis, tenant, keyid) {
  const k = await ownedKey(redis, tenant, keyid);
  const at = k.revoked_at ? Number(k.revoked_at) : Date.now();
  if (!k.revoked_at) await redis("HSET", keyKey(keyid), "revoked_at", String(at));
  return { keyid, status: "revoked", revoked_at: at };
}

/** Key metadata only. Hashes and secrets never leave this module. */
export async function listKeys(redis, tenant) {
  if (!validTenantId(tenant)) throw fail("invalid_tenant");
  const ids = ((await redis("SMEMBERS", tenantKeysSet(tenant))) || []).filter(validKeyId).sort();
  const now = Date.now();
  const out = [];
  for (const id of ids) {
    const k = await readKey(redis, id);
    if (!k || k.tenant !== tenant) continue;
    const meta = {
      keyid: k.keyid,
      label: k.label ?? "",
      status: keyState(k, now),
      created_at: Number(k.created_at) || 0,
      prefix: `${KEY_PREFIX}${k.keyid}_`,
    };
    if (k.expires_at) meta.expires_at = Number(k.expires_at);
    if (k.rotated_to && validKeyId(k.rotated_to)) meta.rotated_to = k.rotated_to;
    if (k.revoked_at) meta.revoked_at = Number(k.revoked_at);
    out.push(meta);
  }
  return out;
}
