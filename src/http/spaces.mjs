// spaces.mjs — space provisioning on the shared registry (WS1).
//
// A space is a key namespace `lm:{space}:*` plus a membership record. This
// module owns the registry side: create, invite, list. The registry lives in
// its own store (LOGMEM_SPACES_REGISTRY_URI, the logmem-redis from WS3) and
// reads fail closed: no env, no silent fallback onto the main backend.
//
// Slugs are single key segments. Colons are refused because the key shape is
// `lm:{space}:...` and a colon in the space would make two different spaces
// read as one structure. Legacy env names like `client:suzanne` stay in
// LOGMEM_SPACES on their deployment; API-created spaces use clean slugs.
import { nativeRedisCall } from "../lib/redis-native.mjs";
import { insecureAllowed } from "../../api/oauth/_lib/storage.mjs";

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Words the key structure already owns: slots, namespaces, index suffixes and
// the operator surfaces. A space named `list` or `channel` would collide with
// `lm:{space}:{ns}:list` reads.
export const RESERVED_SLUGS = new Set([
  "agent", "job", "channel", "session", "sessions", "decision", "ask", "usage",
  "registry", "list", "who", "now", "log", "recap", "follows", "shifts",
  "spaces", "admin", "human", "acmi", "lm", "api", "sp", "thread", "work",
]);

export const SPACE_ROLES = ["owner", "admin", "member"];

export class SpaceError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/** Slug rules: lowercase single segment, no wildcard, no reserved words. */
export function validateSlug(input) {
  const slug = String(input ?? "").trim().toLowerCase();
  if (!slug) throw new SpaceError("invalid_slug", 400, "slug required");
  if (slug.includes("..")) throw new SpaceError("invalid_slug", 400, "slug must not contain '..'");
  if (!SLUG_RE.test(slug)) {
    throw new SpaceError("invalid_slug", 400, "slug must be 1-64 chars of lowercase letters, digits, '.', '_' or '-', starting with a letter or digit");
  }
  if (RESERVED_SLUGS.has(slug)) throw new SpaceError("reserved_slug", 400, `'${slug}' is a reserved word`);
  return slug;
}

function validateIdentity(input) {
  const id = String(input ?? "").trim();
  if (!id || id.length > 128 || /[\x00-\x1f]/.test(id)) {
    throw new SpaceError("invalid_identity", 400, "identity required, max 128 chars, no control characters");
  }
  return id;
}

const REGISTRY_ENV = "LOGMEM_SPACES_REGISTRY_URI";

/**
 * The registry store. Fail closed: without the env the route returns 503 and
 * never falls back to the main backend — new spaces land in logmem-redis
 * from day one (migration decision, spaces plan section 2).
 */
export function registryRedis(env = process.env) {
  const uri = String(env[REGISTRY_ENV] || "").trim();
  if (!uri) throw new SpaceError("registry_not_configured", 503, "space registry is not configured on this deploy");
  if (!/^rediss:\/\//i.test(uri) && !(/^redis:\/\//i.test(uri) && insecureAllowed(env))) {
    throw new SpaceError("registry_not_configured", 503, "space registry URI must be rediss:// (TLS)");
  }
  return async (...cmd) => nativeRedisCall(uri, ...cmd);
}

export const spaceKey = (slug) => `sp:space:${slug}`;
export const membersKey = (slug) => `sp:space:${slug}:members`;
export const memberIndexKey = (identity) => `sp:member:${identity}`;

/** Create a space and seed the creator as owner. SET NX makes create idempotent-safe: a duplicate is a 409, never an overwrite. */
export async function createSpace({ slug: rawSlug, name, actor, redis, now = Date.now() }) {
  const slug = validateSlug(rawSlug);
  const owner = validateIdentity(actor);
  const label = String(name || slug).slice(0, 80);
  const created = await redis("SET", spaceKey(slug), JSON.stringify({ slug, name: label, created_at: now, created_by: owner }), "NX");
  if (created !== "OK") throw new SpaceError("space_exists", 409, `space '${slug}' already exists`);
  await redis("HSET", membersKey(slug), owner, "owner");
  await redis("SADD", memberIndexKey(owner), slug);
  return { slug, name: label, created_at: now, created_by: owner, role: "owner" };
}

/** Add or re-role a member. The actor must be owner or admin of the space. */
export async function invite({ slug: rawSlug, identity: rawIdentity, role, actor, redis }) {
  const slug = validateSlug(rawSlug);
  const identity = validateIdentity(rawIdentity);
  if (!SPACE_ROLES.includes(role)) throw new SpaceError("invalid_role", 400, `role must be one of ${SPACE_ROLES.join(", ")}`);
  const actorRole = await redis("HGET", membersKey(slug), validateIdentity(actor));
  if (!actorRole || actorRole === "member") throw new SpaceError("forbidden", 403, "only an owner or admin of this space can invite");
  await redis("HSET", membersKey(slug), identity, role);
  await redis("SADD", memberIndexKey(identity), slug);
  return { slug, identity, role };
}

/** Every space record this identity is a member of. Unknown or dangling index entries are skipped, never invented. */
export async function listSpaces({ identity, redis }) {
  const id = validateIdentity(identity);
  const slugs = await redis("SMEMBERS", memberIndexKey(id));
  const out = [];
  for (const slug of slugs || []) {
    const raw = await redis("GET", spaceKey(slug));
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      const role = await redis("HGET", membersKey(slug), id);
      out.push({ ...rec, role: role || null });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/** The caller's role in one space, or null. Used by routes to bind writers. */
export async function membershipRole({ slug: rawSlug, identity, redis }) {
  const slug = validateSlug(rawSlug);
  const role = await redis("HGET", membersKey(slug), validateIdentity(identity));
  return role || null;
}
