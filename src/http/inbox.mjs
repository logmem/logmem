// POST /api/inbox/:agent
// Operator-injected inbox item. Writes a work item to acmi:inbox:<agent>:zset
// AND mirrors as an injection event on acmi:agent:<agent>:timeline so the
// Operator Initiation surface + Events view reflect the new item without refresh.
//
// Item shape (acmi:inbox:<agent>:zset, score = ts):
//   {
//     id: "<correlationId>",            // same as event correlationId for cross-ref
//     ts: <epoch ms>,
//     priority: "P0"|"P1"|"P2"|"P3",
//     summary: "<≤280 chars>",
//     kind: "inbox-item",
//     payload: <freeform>,
//     created_by: "<bearer sub>",       // snake_case OK on raw work-item shape
//     state: "pending",                 // snake_case OK on raw work-item shape
//   }
//
// Note (checker advisory, mirrored from plan 04-03): `created_by` / `state` are
// work-item fields on the inbox-item shape, NOT event-envelope fields. Comms
// v1.1 strict camelCase applies to the EVENT ENVELOPE (built by buildEvent —
// correlationId / parentCorrelationId). Existing inbox-item consumers in
// Upstash use snake_case; preserving that here keeps schema-read paths working.
// If we ever camelCase the inbox-item shape, do it across all readers in one go.
//
// Auth: OAuth 2.1 Bearer (shared with /api/mcp) OR env-bearer break-glass
//       (MCP_DIRECT_AUTH_TOKEN / ACMI_WRITE_BEARER). Enforced via withAuth wrapper.
// Idempotency: Idempotency-Key header → 24h dedupe on acmi:idem:inbox-inject:<key>.
//
// Wave 2 plan 04-03: closes phase success criterion #2 (POST /api/inbox/:agent
// injects work item; surfaces in Operator Initiation without refresh) and
// partially closes #6 (401 without bearer with WWW-Authenticate header).
//
// Runtime: Node.js (auth.mjs depends on node:crypto + lookupAccessToken storage).

import { withAuth } from "../_lib/auth.mjs";
import { extractIdempotencyKey, checkIdempotency } from "../_lib/idempotency.mjs";
import { buildEvent, generateCorrelationId } from "../_lib/event-shape.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

// Same allowlist as /api/directive — keep these in sync. (Directive adds a few
// thread-style targets like 'agent-coordination'; inbox injection only targets
// actual agent inboxes, so we keep this list to agent ids only.)
const VALID_AGENTS = new Set([
  "claude", "claude-engineer", "claude-web",
  "bentley", "bentley-main", "bentley-temp",
  "gemini", "gemini-cli",
  "codex",
  "director",
  "gene",
  "test-agent",
]);

const VALID_PRIORITY = new Set(["P0", "P1", "P2", "P3"]);

/**
 * Pull the :agent path param. Vercel parses :agent into req.query.agent on the
 * Node runtime. Fallback parses from the URL path so dev shims + alt routers
 * stay compatible. Output is sanitized to [a-z0-9_-] to keep Redis key shape
 * predictable.
 * @param {object} req
 * @returns {string|null}
 */
function parseAgentParam(req) {
  let agent = req.query?.agent;
  if (!agent) {
    try {
      const u = new URL(req.url, "https://acmi-product.vercel.app");
      const parts = u.pathname.split("/").filter(Boolean);
      // /api/inbox/<agent>
      if (parts[0] === "api" && parts[1] === "inbox" && parts[2]) agent = parts[2];
    } catch {
      // ignore — fall through to null
    }
  }
  return typeof agent === "string" ? agent.replace(/[^a-z0-9_-]/gi, "") : null;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", allowed: ["POST"] });
  }

  try {
    const agent = parseAgentParam(req);
    if (!agent) {
      return res.status(400).json({ error: "agent param required" });
    }
    if (!VALID_AGENTS.has(agent)) {
      return res.status(400).json({
        error: `agent "${agent}" not in allowlist`,
        valid: [...VALID_AGENTS],
      });
    }

    // Parse body. Vercel Node runtime auto-parses JSON when Content-Type is
    // application/json, but be defensive against string-mode delivery.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const { summary, kind, payload, priority, parentCorrelationId } = body;

    if (!summary || typeof summary !== "string" || summary.trim().length === 0) {
      return res.status(400).json({ error: "summary (non-empty string) required" });
    }
    const itemKind = (typeof kind === "string" && kind.trim()) ? kind.trim().slice(0, 64) : "inbox-item";
    const itemPriority = (typeof priority === "string" && VALID_PRIORITY.has(priority)) ? priority : "P2";

    const { redis, sub } = req.acmiAuth;
    const idemKey = extractIdempotencyKey(req);

    const result = await checkIdempotency(redis, "inbox-inject", idemKey, async () => {
      const ts = Date.now();
      const correlationId = generateCorrelationId(itemKind, ts);

      // Raw work-item shape — snake_case fields preserved (see file header note).
      const item = {
        id: correlationId,
        ts,
        priority: itemPriority,
        summary: summary.trim().slice(0, 280),
        kind: itemKind,
        payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined,
        created_by: sub || "operator",
        state: "pending",
        parentCorrelationId: typeof parentCorrelationId === "string" ? parentCorrelationId : undefined,
      };

      // Mirror event envelope — strict camelCase (Comms v1.1).
      const event = buildEvent({
        source: sub || "operator",
        kind: "inbox-injection",
        summary: `[${itemPriority}] injection → ${agent}: ${item.summary}`,
        payload: { item_id: correlationId, target_agent: agent, item },
        tags: ["operator-initiation", "manual-injection"],
        parentCorrelationId: typeof parentCorrelationId === "string" ? parentCorrelationId : undefined,
        correlationId,
        ts,
      });

      const inboxKey = `acmi:inbox:${agent}:zset`;
      const agentTl = `acmi:agent:${agent}:timeline`;

      // Defensive try/catch per Phase 1 hotfix 8880f23 + Phase 4 hotfix ef471db.
      // Primary write is FATAL (can't claim ok:true without it); mirror is
      // non-fatal (Events view fan-in tolerates gaps).
      try {
        await redis("ZADD", inboxKey, String(ts), JSON.stringify(item));
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-inject] ZADD ${inboxKey} failed:`, msg);
        throw new Error(`failed to write inbox item: ${msg}`);
      }

      try {
        await redis("ZADD", agentTl, String(ts), JSON.stringify(event));
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.warn(`[inbox-inject] ZADD ${agentTl} failed (non-fatal):`, msg);
      }

      return {
        ok: true,
        correlationId,
        agent,
        item,
        event,
        written_to: [inboxKey, agentTl],
      };
    });

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(result);
  } catch (e) {
    if (!res.headersSent) {
      const msg = e && e.message ? e.message : String(e);
      console.error("[inbox-inject] handler error:", msg);
      return res.status(500).json({ error: msg, where: "inbox-inject.handler" });
    }
    return undefined;
  }
}

export default withAuth(handler);
