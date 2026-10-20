// agent-keys.mjs — per-agent LogMem keys (service accounts).
//
// A key lets one agent use the hosted server without OAuth: agents that have
// no MCP client and keep a static secret in a vault (Muse's acmi-exec
// pattern). Each key is bound to one space and one agent id, never expires,
// and is revoked by deleting it. The server's own backend serves the key, and
// the space must be one the deploy allows (LOGMEM_SPACES).
//
// Storage (the deploy-owner Redis, next to the OAuth records). The key itself
// is never stored, only its sha256:
//   lm:agentkey:h:<sha256(key)>  — { id, space, agent, label, created_at, created_by }
//   lm:agentkey:id:<id>          — sha256(key), so a key can be revoked by id
//   lm:agentkey:ids              — SET of ids, for the admin list (revoked ids
//                                  are skipped lazily: the list only uses
//                                  commands every deploy Redis allows)

import { randomBytes } from "node:crypto";
import { deployRedis, sha256hex } from "../../api/oauth/_lib/storage.mjs";
import { tryParse } from "../core/store.mjs";
import { checkAgentId } from "../core/session.mjs";
import { validateKeySegments } from "../lib/helpers.mjs";

export const AGENT_KEY_PREFIX = "lmk_";
const K = {
  byHash: (h) => `lm:agentkey:h:${h}`,
  byId: (id) => `lm:agentkey:id:${id}`,
  ids: "lm:agentkey:ids",
};
const LABEL_MAX = 80;

export class AgentKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentKeyError";
  }
}

/** Spaces a key may be bound to: the deploy's own spaces. */
export function keySpaces(env = process.env) {
  return String(env.LOGMEM_SPACES || env.LOGMEM_SPACE || "madez").split(",").map((s) => s.trim()).filter(Boolean);
}

/** Mint a key. Returns { id, key, space, agent, label, created_at }. The key is shown once. */
export async function createAgentKey({ space, agent, label = "", by = "human:admin" }, { env = process.env, redis = deployRedis(), now = Date.now } = {}) {
  const s = String(space || "").trim().toLowerCase();
  try {
    validateKeySegments(s);
  } catch {
    throw new AgentKeyError("space is not valid");
  }
  if (!keySpaces(env).includes(s)) throw new AgentKeyError(`space must be one of: ${keySpaces(env).join(", ")}`);
  let a;
  try {
    a = checkAgentId(String(agent || "").trim());
  } catch (e) {
    throw new AgentKeyError(`agent: ${e.message}`);
  }
  const key = `${AGENT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `ak_${randomBytes(6).toString("hex")}`;
  const rec = { id, space: s, agent: a, label: String(label || "").slice(0, LABEL_MAX), created_at: now(), created_by: String(by) };
  const h = sha256hex(key);
  await redis("SET", K.byHash(h), JSON.stringify(rec));
  await redis("SET", K.byId(id), h);
  await redis("SADD", K.ids, id);
  return { ...rec, key };
}

/** The live keys, newest first. Never includes the key itself. */
export async function listAgentKeys({ redis = deployRedis() } = {}) {
  const out = [];
  for (const id of (await redis("SMEMBERS", K.ids)) || []) {
    const h = await redis("GET", K.byId(id));
    if (!h) continue; // revoked
    const rec = tryParse(await redis("GET", K.byHash(h)));
    if (rec && rec.id === id) out.push(rec);
  }
  return out.sort((x, y) => (y.created_at || 0) - (x.created_at || 0));
}

/** Revoke by id. Returns true when a live key was removed. */
export async function revokeAgentKey(id, { redis = deployRedis() } = {}) {
  if (!/^ak_[0-9a-f]{12}$/.test(String(id || ""))) throw new AgentKeyError("id is not valid");
  const h = await redis("GET", K.byId(id));
  if (!h) return false;
  await redis("DEL", K.byHash(h));
  await redis("DEL", K.byId(id));
  return true;
}

/** Resolve a bearer to { id, space, agent }, or null. Only lmk_ bearers are looked up. */
export async function lookupAgentKey(bearer, { redis } = {}) {
  const b = String(bearer || "");
  if (!b.startsWith(AGENT_KEY_PREFIX) || b.length < AGENT_KEY_PREFIX.length + 40) return null;
  const r = redis || deployRedis();
  const rec = tryParse(await r("GET", K.byHash(sha256hex(b))));
  if (!rec || typeof rec !== "object" || !rec.id || !rec.space || !rec.agent) return null;
  // The id record must still point at this key: a revoke deletes both.
  if ((await r("GET", K.byId(rec.id))) !== sha256hex(b)) return null;
  return { id: rec.id, space: rec.space, agent: rec.agent };
}
