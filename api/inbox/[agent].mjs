import { withCustomerDashboard } from '../../src/http/customer-dashboard.mjs';
// POST /api/inbox/:agent — a person (or system) drops work on an agent.
//
// LogMem port of the ACMI inbox: instead of a side ZSET, the item is a
// Handoff entry on lm:{space}:agent:{agent}:log, so it shows up in that
// agent's Brief under handoffs_to_me until the agent notes "accepted".
//
// Body: { summary, priority?: "P0".."P3", payload?, trail? }
// Limits (same as every write tool): summary 280 characters here (an inbox
// item is a one-liner), payload 16 KB as JSON, trail 200. Inbox items are
// always kind "handoff"; nothing here can write "decided".
// Auth: same resolver as /api/mcp (OAuth bearer, config, headers, break-glass).

import { createStore } from "../../src/core/store.mjs";
import { makeTrail, capJson, capText, LIMITS } from "../../src/core/tools.mjs";
import { fromDescriptor } from "../../src/lib/backend.mjs";
import { validateKeySegments } from "../../src/lib/helpers.mjs";
import { checkAgentId } from "../../src/core/keys.mjs";
import { sendServerError } from "../../src/http/log.mjs";
import { resolveAuth, decodeConfig, wwwAuthenticate } from "../../src/http/auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const PRIORITY = new Set(["P0", "P1", "P2", "P3"]);

async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const auth = await resolveAuth(req, decodeConfig(req));
    const b = auth.backend && fromDescriptor(auth.backend);
    if (!b) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate(req));
      return res.status(401).json({ error: "authentication required" });
    }
    // The inbox records a person as the writer. An agent key is an agent, so it
    // must hand off through MCP (logmem_handoff), never as a human here.
    // Agent keys and managed accounts are agents, jailed to one space with plan
    // limits: they hand off through MCP (logmem_handoff), never through this
    // raw, unjailed route that records a human writer (grok-local, #62 review).
    if (auth.source === "agent-key" || auth.source === "managed") return res.status(403).json({ error: "this credential cannot post to the inbox; use logmem_handoff over MCP" });
    const agent = String(req.query?.agent || "").toLowerCase();
    try {
      validateKeySegments(agent);
      checkAgentId(agent);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const { summary, priority = "P2", payload, trail } = req.body || {};
    if (!summary || typeof summary !== "string" || summary.length > 280) return res.status(400).json({ error: "summary required, max 280 chars" });
    if (!PRIORITY.has(priority)) return res.status(400).json({ error: "priority must be P0..P3" });
    if (trail != null && typeof trail !== "string") return res.status(400).json({ error: "trail must be a string" });
    try {
      capText("trail", trail, LIMITS.trail);
      capJson("payload", payload);
    } catch (e) {
      return res.status(413).json({ error: e.message });
    }

    const store = createStore(b.redis, { space: auth.space });
    if (trail) {
      const prior = await store.readLog("agent", agent);
      if (prior.some((e) => e.trail === trail)) {
        return res.status(409).json({ error: `trail '${trail}' is already used on agent ${agent}; omit trail to mint a new one` });
      }
    }
    const ts = Date.now();
    const by = auth.sub ? `human:${String(auth.sub).replace(/[^a-z0-9_.-]/gi, "-")}` : "human:operator";
    const entry = await store.append("agent", agent, {
      ts,
      kind: "handoff",
      by,
      via: "inbox",
      byline: `${by.replace(/^human:/, "")} (via inbox)`,
      to: `agent:${agent}`,
      trail: trail || makeTrail("inbox", agent, ts),
      priority,
      summary: String(summary),
      ...(payload !== undefined ? { payload } : {}),
    });
    return res.status(201).json({ ok: true, space: auth.space, agent, entry });
  } catch (e) {
    return sendServerError(res, "/api/inbox", e);
  }
}

export default withCustomerDashboard(handler);
