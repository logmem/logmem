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
import { resolveAuth, decodeConfig, wwwAuthenticate } from "../../src/http/auth.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const PRIORITY = new Set(["P0", "P1", "P2", "P3"]);

export default async function handler(req, res) {
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
    const agent = String(req.query?.agent || "").toLowerCase();
    validateKeySegments(agent);
    if (!/^[a-z0-9_-]+$/.test(agent)) return res.status(400).json({ error: "agent must be [a-z0-9_-]" });

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
    return res.status(500).json({ error: e.message });
  }
}
