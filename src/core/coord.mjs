// coord.mjs — Fleet coordination item identity, storage, CAS settlement and indexing.
//
// Part of the P0 Fleet Coordination Sync Contract (PR A).
// An item is one obligation owed by one recipient (a handoff, huddle seat, or directed request).
//
// Keys:
//   lm:{space}:coord:item:{id}           — Hash: item record
//   lm:{space}:coord:open                — ZSet: score = deadline, member = id
//   lm:{space}:coord:open:{agent}        — ZSet: score = deadline, member = id
//   lm:{space}:coord:trail:{trail}       — Set: member = item id
//   lm:{space}:coord:coverage            — Hash: coverage status of backfill/index

import { createHash } from "node:crypto";
import { PREFIX } from "./keys.mjs";
import { registerEvalScript } from "../lib/lua-scripts.mjs";

export const COORD_DEADLINE_MS = 86_400_000; // 24 hours

/**
 * Deterministic Item ID generator.
 * ci_ + first 24 chars of sha256(space|type|requestTrail|recipient).
 */
export function computeItemId(space, type, requestTrail, recipient) {
  const normRecipient = String(recipient || "").replace(/^agent:/, "");
  const payload = `${space}|${type}|${requestTrail}|${normRecipient}`;
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 24);
  return `ci_${hash}`;
}

export function coordItemKey(space, id) {
  return `${PREFIX}:${space}:coord:item:${id}`;
}

export function coordOpenKey(space) {
  return `${PREFIX}:${space}:coord:open`;
}

export function coordAgentOpenKey(space, agent) {
  const norm = String(agent || "").replace(/^agent:/, "");
  return `${PREFIX}:${space}:coord:open:${norm}`;
}

export function coordTrailKey(space, trail) {
  return `${PREFIX}:${space}:coord:trail:${trail}`;
}

export function coordCoverageKey(space) {
  return `${PREFIX}:${space}:coord:coverage`;
}

// ─── Lua Scripts ─────────────────────────────────────────────────────────────

/**
 * Atomic creation of a coordination item.
 * KEYS[1]: item key
 * KEYS[2]: open zset key
 * KEYS[3]: agent open zset key
 * KEYS[4]: trail set key
 * ARGV: [id, space, type, request_trail, from, to, where, summary, expects, created_at, deadline]
 */
export const COORD_CREATE_ITEM_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 1 then
  return 'exists'
end
local id = ARGV[1]
local deadline = tonumber(ARGV[11])

redis.call('HSET', KEYS[1],
  'id', id,
  'space', ARGV[2],
  'type', ARGV[3],
  'request_trail', ARGV[4],
  'from', ARGV[5],
  'to', ARGV[6],
  'where', ARGV[7],
  'summary', ARGV[8],
  'expects', ARGV[9],
  'created_at', ARGV[10],
  'deadline', ARGV[11],
  'response', 'open',
  'disposition', '',
  'settled_by', '',
  'settled_at', '',
  'settlement_trail', '',
  'next_action', '',
  'last_nudge_at', ''
)
redis.call('ZADD', KEYS[2], deadline, id)
redis.call('ZADD', KEYS[3], deadline, id)
redis.call('SADD', KEYS[4], id)
return 'ok'
`;

registerEvalScript(
  COORD_CREATE_ITEM_LUA,
  (call, keys, argv) => {
    const exists = call("EXISTS", keys[0]);
    if (exists === 1 || exists === true) return "exists";
    const id = argv[0];
    const deadline = Number(argv[10]);
    call(
      "HSET",
      keys[0],
      "id", id,
      "space", argv[1],
      "type", argv[2],
      "request_trail", argv[3],
      "from", argv[4],
      "to", argv[5],
      "where", argv[6],
      "summary", argv[7],
      "expects", argv[8],
      "created_at", argv[9],
      "deadline", argv[10],
      "response", "open",
      "disposition", "",
      "settled_by", "",
      "settled_at", "",
      "settlement_trail", "",
      "next_action", "",
      "last_nudge_at", ""
    );
    call("ZADD", keys[1], deadline, id);
    call("ZADD", keys[2], deadline, id);
    call("SADD", keys[3], id);
    return "ok";
  },
  { jail: true }
);

/**
 * Compare-And-Swap (CAS) atomic settlement of a coordination item.
 * KEYS[1]: item key
 * KEYS[2]: open zset key
 * KEYS[3]: agent open zset key
 * ARGV: [id, recipient, response, settled_by, settled_at, settlement_trail, disposition]
 */
export const COORD_SETTLE_ITEM_LUA = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  return 'not_found'
end

local resp = redis.call('HGET', KEYS[1], 'response')
if resp ~= 'open' then
  return 'already_settled'
end

local target = redis.call('HGET', KEYS[1], 'to')
local expected = ARGV[2]
if target ~= expected and target ~= ('agent:' .. expected) and ('agent:' .. target) ~= expected then
  return 'wrong_recipient'
end

local id = ARGV[1]
local response = ARGV[3]
local settled_by = ARGV[4]
local settled_at = ARGV[5]
local settlement_trail = ARGV[6]
local disposition = ARGV[7] or ''

redis.call('HSET', KEYS[1],
  'response', response,
  'settled_by', settled_by,
  'settled_at', settled_at,
  'settlement_trail', settlement_trail,
  'disposition', disposition
)

redis.call('ZREM', KEYS[2], id)
redis.call('ZREM', KEYS[3], id)
return 'ok'
`;

registerEvalScript(
  COORD_SETTLE_ITEM_LUA,
  (call, keys, argv) => {
    const exists = call("EXISTS", keys[0]);
    if (!exists || exists === 0) return "not_found";

    const resp = call("HGET", keys[0], "response");
    if (resp !== "open") return "already_settled";

    const target = call("HGET", keys[0], "to");
    const expected = argv[1];
    if (target !== expected && target !== `agent:${expected}` && `agent:${target}` !== expected) {
      return "wrong_recipient";
    }

    const id = argv[0];
    const response = argv[2];
    const settled_by = argv[3];
    const settled_at = argv[4];
    const settlement_trail = argv[5];
    const disposition = argv[6] || "";

    call(
      "HSET",
      keys[0],
      "response", response,
      "settled_by", settled_by,
      "settled_at", settled_at,
      "settlement_trail", settlement_trail,
      "disposition", disposition
    );

    call("ZREM", keys[1], id);
    call("ZREM", keys[2], id);
    return "ok";
  },
  { jail: true }
);

// ─── Operations API ──────────────────────────────────────────────────────────

/**
 * Creates a coordination item atomically in Redis.
 */
export async function createCoordItem(store, item) {
  const {
    space = store.space,
    type = "handoff",
    requestTrail,
    from,
    to,
    where = "",
    summary = "",
    expects = "accept_or_decline",
    createdAt = Date.now(),
  } = item;

  const normTo = String(to || "").replace(/^agent:/, "");
  const id = computeItemId(space, type, requestTrail, normTo);
  const deadline = createdAt + COORD_DEADLINE_MS;

  const itemKey = coordItemKey(space, id);
  const openKey = coordOpenKey(space);
  const agentOpenKey = coordAgentOpenKey(space, normTo);
  const trailKey = coordTrailKey(space, requestTrail);

  const keys = [itemKey, openKey, agentOpenKey, trailKey];
  const argv = [
    id,
    space,
    type,
    requestTrail,
    String(from || ""),
    String(to || ""),
    String(where || ""),
    String(summary || ""),
    String(expects || ""),
    String(createdAt),
    String(deadline),
  ];

  const res = await store.redis("EVAL", COORD_CREATE_ITEM_LUA, keys.length, ...keys, ...argv);
  return { ok: res === "ok" || res === "exists", id, status: res };
}

/**
 * CAS settlement of a coordination item.
 */
export async function settleCoordItem(store, {
  space = store.space,
  id,
  recipient,
  response = "answered", // "answered" | "declined"
  settledBy,
  settledAt = Date.now(),
  settlementTrail = "",
  disposition = "",
}) {
  const normRecipient = String(recipient || "").replace(/^agent:/, "");
  const itemKey = coordItemKey(space, id);
  const openKey = coordOpenKey(space);
  const agentOpenKey = coordAgentOpenKey(space, normRecipient);

  const keys = [itemKey, openKey, agentOpenKey];
  const argv = [
    id,
    normRecipient,
    response,
    String(settledBy || recipient),
    String(settledAt),
    String(settlementTrail || ""),
    String(disposition || ""),
  ];

  const res = await store.redis("EVAL", COORD_SETTLE_ITEM_LUA, keys.length, ...keys, ...argv);
  return {
    ok: res === "ok",
    status: res,
    id,
    alreadySettled: res === "already_settled",
  };
}

/**
 * Fetches a single coordination item record by ID.
 */
export async function getCoordItem(store, space, id) {
  const itemKey = coordItemKey(space, id);
  const raw = await store.redis("HGETALL", itemKey);
  if (!raw || (Array.isArray(raw) && raw.length === 0) || (typeof raw === "object" && Object.keys(raw).length === 0)) {
    return null;
  }

  // Handle both array representation and key-value object from Redis clients
  const obj = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i += 2) {
      obj[raw[i]] = raw[i + 1];
    }
  } else {
    Object.assign(obj, raw);
  }

  return {
    ...obj,
    created_at: Number(obj.created_at) || 0,
    deadline: Number(obj.deadline) || 0,
    settled_at: obj.settled_at ? Number(obj.settled_at) : null,
    is_overdue: obj.response === "open" && Number(obj.deadline) < Date.now(),
  };
}

/**
 * Lists open coordination items for an agent, ordered by deadline.
 */
export async function listOpenCoordItemsForAgent(store, space, agent) {
  const norm = String(agent || "").replace(/^agent:/, "");
  const key = coordAgentOpenKey(space, norm);
  const ids = await store.redis("ZRANGE", key, 0, -1);
  if (!ids || ids.length === 0) return [];

  const items = [];
  for (const id of ids) {
    const item = await getCoordItem(store, space, id);
    if (item && item.response === "open") {
      items.push(item);
    }
  }
  return items;
}

/**
 * Finds all item IDs associated with a request trail.
 */
export async function getCoordItemsByTrail(store, space, trail) {
  const key = coordTrailKey(space, trail);
  const ids = await store.redis("SMEMBERS", key);
  return Array.isArray(ids) ? ids : [];
}
