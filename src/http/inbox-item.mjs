// PATCH /api/inbox/:agent/:itemId
// Mutates an existing inbox item's state. Three actions supported:
//   - mark-resolved: state="resolved", resolved_by, resolved_ts
//   - snooze:        state="snoozed", snoozed_until_ms (and score-bumps zset member)
//   - reassign:      owner=<newOwner>, state="reassigned"
//
// Implementation: ZREVRANGE the inbox zset to locate item by id, ZREM the old
// member, ZADD the updated member. Snooze re-scores to until_ms so snoozed
// items sort to the future end of the zset. Best-effort restore on ZADD failure
// keeps the inbox consistent if the second leg of the swap fails.
//
// Mirror: emits a kind=inbox-mutation event onto acmi:agent:<agent>:timeline so
// the Events view fan-in surfaces the mutation within one poll cycle.
//
// Item-field shapes (snake_case OK per 04-03 checker advisory): resolved_by /
// resolved_ts / snoozed_until_ms / snoozed_by / snoozed_ts / reassigned_by /
// reassigned_ts / previous_owner are work-item fields, NOT event-envelope
// fields. Comms v1.1 strict camelCase applies ONLY to the event envelope built
// by buildEvent (correlationId / parentCorrelationId).
//
// Auth: OAuth 2.1 Bearer (shared with /api/mcp) OR env-bearer break-glass
//       (MCP_DIRECT_AUTH_TOKEN / ACMI_WRITE_BEARER). Enforced via withAuth.
// Idempotency: Idempotency-Key header → 24h dedupe on acmi:idem:inbox-mutate:<key>.
//
// Wave 2 plan 04-05: closes phase success criterion #4 (PATCH mutates inbox
// item state; Events view reflects the update) and partially closes #6 (401
// without bearer for 4 of 5 endpoints).
//
// Runtime: Node.js (auth.mjs depends on node:crypto + lookupAccessToken storage).

import { withAuth } from "../../_lib/auth.mjs";
import { extractIdempotencyKey, checkIdempotency } from "../../_lib/idempotency.mjs";
import { buildEvent } from "../../_lib/event-shape.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const VALID_ACTIONS = new Set(["mark-resolved", "snooze", "reassign"]);

// Mirror of /api/inbox/[agent].mjs::VALID_AGENTS — keep these in sync.
const VALID_AGENTS = new Set([
  "claude", "claude-engineer", "claude-web",
  "bentley", "bentley-main", "bentley-temp",
  "gemini", "gemini-cli",
  "codex",
  "director",
  "gene",
  "test-agent",
]);

/**
 * Pull :agent and :itemId path params. Vercel Node runtime parses them into
 * req.query.agent / req.query.itemId. URL-path fallback keeps dev shims + alt
 * routers compatible. Both outputs are character-sanitized to keep Redis key
 * shape predictable (agent: [a-z0-9_-], itemId: [a-zA-Z0-9_-] since
 * correlationIds include random hex tails).
 * @param {object} req
 * @returns {{agent: string|null, itemId: string|null}}
 */
function parseParams(req) {
  let agent = req.query?.agent;
  let itemId = req.query?.itemId;
  if (!agent || !itemId) {
    try {
      const u = new URL(req.url, "https://acmi-product.vercel.app");
      const parts = u.pathname.split("/").filter(Boolean);
      // /api/inbox/<agent>/<itemId>
      if (parts[0] === "api" && parts[1] === "inbox") {
        agent = agent || parts[2];
        itemId = itemId || parts[3];
      }
    } catch {
      // ignore — fall through to whatever we have
    }
  }
  return {
    agent: typeof agent === "string" ? agent.replace(/[^a-z0-9_-]/gi, "") : null,
    itemId: typeof itemId === "string" ? itemId.replace(/[^a-zA-Z0-9_-]/g, "") : null,
  };
}

/**
 * Bounded scan of an inbox zset to locate an item by id. Returns the raw
 * member-string (needed for ZREM) + parsed item + score. Bound is 500 items
 * which is well above any real inbox depth — if we ever hit it in production
 * we add a secondary HSET index per item-id.
 * @param {Function} redis
 * @param {string} key
 * @param {string} itemId
 * @returns {Promise<{item: object, originalMember: string, score: number}|null>}
 */
async function findItemInZset(redis, key, itemId) {
  const raw = (await redis("ZREVRANGE", key, "0", "499", "WITHSCORES")) || [];
  // raw is [member1, score1, member2, score2, ...]
  for (let i = 0; i < raw.length; i += 2) {
    try {
      const item = JSON.parse(raw[i]);
      if (item && item.id === itemId) {
        return {
          item,
          originalMember: raw[i],
          score: Number(raw[i + 1]) || item.ts || Date.now(),
        };
      }
    } catch {
      // skip un-parseable member
    }
  }
  return null;
}

async function handler(req, res) {
  if (req.method !== "PATCH") {
    return res.status(405).json({ error: "Method not allowed", allowed: ["PATCH"] });
  }

  try {
    const { agent, itemId } = parseParams(req);
    if (!agent) return res.status(400).json({ error: "agent param required" });
    if (!itemId) return res.status(400).json({ error: "itemId param required" });
    if (!VALID_AGENTS.has(agent)) {
      return res.status(400).json({
        error: `agent "${agent}" not in allowlist`,
        valid: [...VALID_AGENTS],
      });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { action, newOwner, until_ms, note } = body;

    if (!action || !VALID_ACTIONS.has(action)) {
      return res.status(400).json({
        error: `action required: one of ${[...VALID_ACTIONS].join(", ")}`,
      });
    }
    if (action === "reassign" && (!newOwner || typeof newOwner !== "string")) {
      return res.status(400).json({ error: "newOwner (string) required for action=reassign" });
    }
    if (action === "snooze") {
      const u = Number(until_ms);
      if (!Number.isFinite(u) || u <= Date.now()) {
        return res.status(400).json({ error: "until_ms (future epoch ms) required for action=snooze" });
      }
    }

    const { redis, sub } = req.acmiAuth;
    const idemKey = extractIdempotencyKey(req);

    const result = await checkIdempotency(redis, "inbox-mutate", idemKey, async () => {
      const inboxKey = `acmi:inbox:${agent}:zset`;
      let found;
      try {
        found = await findItemInZset(redis, inboxKey, itemId);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-mutate] locate failed:`, msg);
        throw new Error(`failed to locate item: ${msg}`);
      }
      if (!found) {
        const err = new Error(`item not found: ${itemId}`);
        err.statusCode = 404;
        throw err;
      }

      const ts = Date.now();
      const updated = { ...found.item };
      if (action === "mark-resolved") {
        updated.state = "resolved";
        updated.resolved_by = sub || "operator";
        updated.resolved_ts = ts;
        if (typeof note === "string") updated.resolve_note = note.slice(0, 280);
      } else if (action === "snooze") {
        updated.state = "snoozed";
        updated.snoozed_until_ms = Number(until_ms);
        updated.snoozed_by = sub || "operator";
        updated.snoozed_ts = ts;
        if (typeof note === "string") updated.snooze_note = note.slice(0, 280);
      } else if (action === "reassign") {
        updated.state = "reassigned";
        updated.previous_owner = updated.owner;
        updated.owner = newOwner;
        updated.reassigned_by = sub || "operator";
        updated.reassigned_ts = ts;
        if (typeof note === "string") updated.reassign_note = note.slice(0, 280);
      }

      // Replace member in zset atomically. ZREM + ZADD pair — Upstash ZADD
      // does not transparently update existing members by id (member equality
      // is by full value-string, which differs after mutation), so we remove
      // the old member and add the new one. Snooze re-scores to until_ms;
      // other actions preserve original score (queue position).
      const newScore = action === "snooze" ? Number(until_ms) : found.score;
      try {
        await redis("ZREM", inboxKey, found.originalMember);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-mutate] ZREM ${inboxKey} failed:`, msg);
        throw new Error(`failed to remove old item: ${msg}`);
      }
      try {
        await redis("ZADD", inboxKey, String(newScore), JSON.stringify(updated));
      } catch (e) {
        // Best-effort restore on failure — re-add the original member so the
        // inbox doesn't end up with a hole on partial swap.
        try {
          await redis("ZADD", inboxKey, String(found.score), found.originalMember);
        } catch {
          // restore failed; nothing more we can do here
        }
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-mutate] ZADD ${inboxKey} failed:`, msg);
        throw new Error(`failed to write updated item: ${msg}`);
      }

      // Mirror as event on agent timeline so Events view fan-in picks it up.
      // Envelope is strict camelCase (Comms v1.1). parentCorrelationId links
      // the mutation event back to the original inbox-injection event by id.
      const event = buildEvent({
        source: sub || "operator",
        kind: "inbox-mutation",
        summary: `inbox-mutation [${agent}/${itemId}] action=${action}`,
        payload: {
          agent,
          itemId,
          action,
          previous_state: found.item.state,
          new_state: updated.state,
          newOwner,
          until_ms,
          note,
        },
        tags: ["operator-initiation", `action:${action}`],
        parentCorrelationId: itemId,
      });
      try {
        await redis(
          "ZADD",
          `acmi:agent:${agent}:timeline`,
          String(event.ts),
          JSON.stringify(event),
        );
      } catch (e) {
        // Mirror is non-fatal (Events view fan-in tolerates gaps).
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-mutate] timeline ZADD failed (non-fatal):`, msg);
      }

      return { ok: true, agent, itemId, action, updated, event };
    });

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(result);
  } catch (e) {
    if (e && e.statusCode === 404) {
      if (!res.headersSent) return res.status(404).json({ error: e.message });
      return undefined;
    }
    if (!res.headersSent) {
      const msg = e && e.message ? e.message : String(e);
      console.error("[inbox-mutate] handler error:", msg);
      return res.status(500).json({ error: msg, where: "inbox-mutate.handler" });
    }
    return undefined;
  }
}

export default withAuth(handler);
