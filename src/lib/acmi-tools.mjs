// mcp-tools.mjs — 16 ACMI tool definitions, shared between transports.
//
// Used by:
//   - the stdio MCP server at ~/.openclaw/skills/acmi/mcp-server.mjs (npm @madezmedia/acmi-mcp)
//   - the HTTP MCP route at acmi-product/api/mcp.mjs (Smithery URL-published)
//
// Each tool handler closes over the `redis` client parameter, so the same
// business logic runs whether the transport is stdio (Mikey's tenant via
// process.env) or HTTP (customer's tenant via Smithery base64 config).
//
// IMPORTANT: this module is transport-agnostic. Do not import StdioTransport,
// StreamableHTTPTransport, or any process-level state here. Pure registration.

import { z } from "zod";
import { validateKeySegments, validateJson, isProtectedKey } from "./mcp-server-helpers.mjs";

// ─── Result + utility helpers ───────────────────────────────────────

function jsonResult(data) {
  // Grok Bot / Cursor require structuredContent when tools/list advertises outputSchema.
  const structured = Array.isArray(data)
    ? { ok: true, ids: data }
    : (data !== null && typeof data === "object" ? data : { ok: true, value: data });
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

function safeTool(name, fn) {
  return async (args) => {
    try { return await fn(args); }
    catch (e) { return jsonResult({ ok: false, error: e.message, tool: name }); }
  };
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

export function normTs(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x > 1e17) return Math.floor(x / 1e6); // ns -> ms
  if (x > 1e14) return Math.floor(x / 1e3); // us -> ms
  if (x < 1e11) return Math.floor(x * 1e3); // s -> ms
  return Math.floor(x);
}

function physKey(redis, key) {
  return typeof redis.keyFor === "function" ? redis.keyFor(key) : key;
}

export function parseZWithScores(arr) {
  const out = [];
  for (let i = 0; i < (arr || []).length; i += 2) {
    out.push({ ts: normTs(arr[i + 1]), raw_score: arr[i + 1], data: tryParse(arr[i]) });
  }
  return out;
}

function parseHash(arr) {
  const out = {};
  for (let i = 0; i < (arr || []).length; i += 2) {
    out[arr[i]] = tryParse(arr[i + 1]);
  }
  return out;
}

function stringArray(value, fieldNames = []) {
  const parsed = typeof value === "string" ? tryParse(value) : value;
  if (Array.isArray(parsed)) {
    return parsed.map(String).filter(Boolean);
  }
  if (parsed && typeof parsed === "object") {
    for (const field of fieldNames) {
      if (Array.isArray(parsed[field])) {
        return parsed[field].map(String).filter(Boolean);
      }
    }
  }
  return [];
}

function extractProfileId(key, namespace) {
  const parts = String(key || "").split(":");
  const idx = parts.lastIndexOf(namespace);
  if (idx < 0 || parts[idx + 2] !== "profile") return null;
  return parts[idx + 1] || null;
}

async function redisType(redis, key) {
  const type = await redis("TYPE", key);
  return String(type || "none").toLowerCase();
}

export async function addListId(redis, key, id, { fieldNames = ["ids"] } = {}) {
  const type = await redisType(redis, key);
  if (type === "none" || type === "set") {
    await redis("SADD", key, id);
    return { key, type: type === "none" ? "set" : type };
  }
  if (type === "string") {
    const current = stringArray(await redis("GET", key), fieldNames);
    if (!current.includes(id)) {
      current.push(id);
      await redis("SET", key, JSON.stringify(current));
    }
    return { key, type };
  }
  if (type === "list") {
    const current = stringArray(await redis("LRANGE", key, 0, -1));
    if (!current.includes(id)) await redis("RPUSH", key, id);
    return { key, type };
  }
  if (type === "hash") {
    await redis("HSET", key, id, "1");
    return { key, type };
  }
  throw new Error(`Unsupported ACMI list index type for ${key}: ${type}`);
}

export async function readListIds(redis, key, {
  namespace,
  profilePattern,
  fieldNames = ["ids"],
} = {}) {
  let ids = [];
  const type = await redisType(redis, key);
  if (type === "set") {
    ids = stringArray(await redis("SMEMBERS", key));
  } else if (type === "string") {
    ids = stringArray(await redis("GET", key), fieldNames);
  } else if (type === "list") {
    ids = stringArray(await redis("LRANGE", key, 0, -1));
  } else if (type === "hash") {
    ids = Object.keys(parseHash(await redis("HGETALL", key)));
  } else if (type !== "none") {
    throw new Error(`Unsupported ACMI list index type for ${key}: ${type}`);
  }

  if (profilePattern && namespace) {
    const profileKeys = stringArray(await redis("KEYS", profilePattern));
    ids.push(...profileKeys.map((k) => extractProfileId(k, namespace)).filter(Boolean));
  }

  return Array.from(new Set(ids.map(String).filter(Boolean))).sort();
}

export async function readObjectByType(redis, key) {
  const type = await redisType(redis, key);
  if (type === "hash") return parseHash(await redis("HGETALL", key));
  if (type === "string") {
    const parsed = tryParse(await redis("GET", key));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  }
  if (type === "none") return {};
  throw new Error(`Unsupported ACMI object key type for ${key}: ${type}`);
}

async function writeActiveContextEntry(redis, key, threadKey, value) {
  const type = await redisType(redis, key);
  if (type === "none" || type === "hash") {
    await redis("HSET", key, threadKey, JSON.stringify(value));
    return;
  }
  if (type === "string") {
    const current = await readObjectByType(redis, key);
    current[threadKey] = value;
    await redis("SET", key, JSON.stringify(current));
    return;
  }
  throw new Error(`Unsupported ACMI active_context type for ${key}: ${type}`);
}

async function deleteActiveContextEntry(redis, key, threadKey) {
  const type = await redisType(redis, key);
  if (type === "none") return;
  if (type === "hash") {
    await redis("HDEL", key, threadKey);
    return;
  }
  if (type === "string") {
    const current = await readObjectByType(redis, key);
    delete current[threadKey];
    await redis("SET", key, JSON.stringify(current));
    return;
  }
  throw new Error(`Unsupported ACMI active_context type for ${key}: ${type}`);
}

function parseSince(s) {
  const m = String(s).match(/^(\d+)([hdm])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return n * (m[2] === "h" ? 3600e3 : m[2] === "d" ? 86400e3 : 60e3);
}

// ─── Public: register all 16 ACMI tools on a server ─────────────────

export function registerAcmiTools(server, redis) {
  // 1. acmi_profile
  server.tool(
    "acmi_profile",
    "Create or update an entity profile in ACMI. Stores arbitrary JSON profile data for an entity (agent, thread, project, etc.).",
    {
      namespace: z.string().describe("ACMI namespace (e.g. 'agent', 'thread', 'sales')"),
      id: z.string().describe("Entity ID within the namespace"),
      profile: z.string().describe("JSON string of profile data to store"),
    },
    safeTool("acmi_profile", async ({ namespace, id, profile }) => {
      validateKeySegments(namespace, id);
      validateJson(profile, "profile");
      const key = `acmi:${namespace}:${id}:profile`;
      await redis("SET", key, profile);
      await addListId(redis, `acmi:${namespace}:list`, id);
      return jsonResult({ ok: true, key: physKey(redis, key) });
    })
  );

  // 2. acmi_signal
  server.tool(
    "acmi_signal",
    "Update AI signals for an entity. Signals are mutable KV state (mood, priorities, scores, etc.) that changes frequently.",
    {
      namespace: z.string().describe("ACMI namespace"),
      id: z.string().describe("Entity ID"),
      signals: z.string().describe("JSON string of signal data to store"),
    },
    safeTool("acmi_signal", async ({ namespace, id, signals }) => {
      validateKeySegments(namespace, id);
      validateJson(signals, "signals");
      const key = `acmi:${namespace}:${id}:signals`;
      await redis("SET", key, signals);
      await addListId(redis, `acmi:${namespace}:list`, id);
      return jsonResult({ ok: true, key: physKey(redis, key) });
    })
  );

  // 3. acmi_event
  server.tool(
    "acmi_event",
    "Log a timeline event for an entity. The workhorse tool — records timestamped events with source, kind, correlationId, and summary. Follows ACMI Communication Standard v1.1.",
    {
      namespace: z.string().describe("ACMI namespace (e.g. 'thread', 'agent', 'work')"),
      id: z.string().describe("Entity ID"),
      source: z.string().describe("Source of the event (agent name, system, etc.)"),
      summary: z.string().describe("Human-readable event summary"),
      kind: z.string().optional().describe("Event kind (e.g. 'handoff-complete', 'step-done', 'decision')"),
      correlationId: z.string().optional().describe("Correlation ID for tracking across agents/sessions (camelCase)"),
      parentCorrelationId: z.string().optional().describe("Parent correlation ID for chain tracking (camelCase)"),
    },
    safeTool("acmi_event", async ({ namespace, id, source, summary, kind, correlationId, parentCorrelationId }) => {
      validateKeySegments(namespace, id);
      const key = `acmi:${namespace}:${id}:timeline`;
      const ts = Date.now();
      const event = { ts, source, summary };
      if (kind) event.kind = kind;
      if (correlationId) event.correlationId = correlationId;
      if (parentCorrelationId) event.parentCorrelationId = parentCorrelationId;
      await redis("ZADD", key, ts, JSON.stringify(event));
      await addListId(redis, `acmi:${namespace}:list`, id);
      return jsonResult({ ok: true, key: physKey(redis, key), event });
    })
  );

  // 4. acmi_get
  server.tool(
    "acmi_get",
    "Fetch complete entity context: profile + signals + recent timeline events (last 10).",
    {
      namespace: z.string().describe("ACMI namespace"),
      id: z.string().describe("Entity ID"),
    },
    safeTool("acmi_get", async ({ namespace, id }) => {
      validateKeySegments(namespace, id);
      const prefix = `acmi:${namespace}:${id}`;
      const [profile, signals, timeline] = await Promise.all([
        redis("GET", `${prefix}:profile`),
        redis("GET", `${prefix}:signals`),
        redis("ZRANGE", `${prefix}:timeline`, 0, -1, "WITHSCORES"),
      ]);
      const recent = parseZWithScores(timeline)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 10)
        .map((e) => e.data);
      return jsonResult({
        profile: profile ? tryParse(profile) : null,
        signals: signals ? tryParse(signals) : null,
        timeline_recent: recent,
      });
    })
  );

  // 5. acmi_list
  server.tool(
    "acmi_list",
    "List all entity IDs in a namespace.",
    {
      namespace: z.string().describe("ACMI namespace to list"),
    },
    safeTool("acmi_list", async ({ namespace }) => {
      validateKeySegments(namespace);
      const ids = await readListIds(redis, `acmi:${namespace}:list`, {
        namespace,
        profilePattern: `acmi:${namespace}:*:profile`,
        fieldNames: ["ids"],
      });
      return jsonResult({ ok: true, ids });
    })
  );

  // 6. acmi_work_create
  server.tool(
    "acmi_work_create",
    "Create a new work item (cross-session project, task, or idea).",
    {
      id: z.string().describe("Unique work item ID"),
      profile: z.string().describe("JSON string of work item profile (title, owner, status, etc.)"),
    },
    safeTool("acmi_work_create", async ({ id, profile }) => {
      validateKeySegments(id);
      validateJson(profile, "profile");
      await redis("SET", `acmi:work:${id}:profile`, profile);
      await addListId(redis, "acmi:work:list", id, { fieldNames: ["work_ids", "ids"] });
      return jsonResult({ ok: true, work_id: id });
    })
  );

  // 7. acmi_work_event
  server.tool(
    "acmi_work_event",
    "Log a progress event on a work item.",
    {
      id: z.string().describe("Work item ID"),
      source: z.string().describe("Source of the event"),
      summary: z.string().describe("Event summary"),
      kind: z.string().optional().describe("Event kind"),
      correlationId: z.string().optional().describe("Correlation ID for chain tracking"),
      parentCorrelationId: z.string().optional().describe("Parent correlation ID for chain tracking"),
      sessionId: z.string().optional().describe("Optional session ID to associate"),
    },
    safeTool("acmi_work_event", async ({ id, source, summary, kind, correlationId, parentCorrelationId, sessionId }) => {
      validateKeySegments(id);
      const ts = Date.now();
      const event = { ts, source, summary };
      if (kind) event.kind = kind;
      if (correlationId) event.correlationId = correlationId;
      if (parentCorrelationId) event.parentCorrelationId = parentCorrelationId;
      if (sessionId) event.session_id = sessionId;
      await redis("ZADD", `acmi:work:${id}:timeline`, ts, JSON.stringify(event));
      if (sessionId) await redis("SADD", `acmi:work:${id}:sessions`, sessionId);
      return jsonResult({ ok: true, work_id: id, event });
    })
  );

  // 8. acmi_work_signal
  server.tool(
    "acmi_work_signal",
    "Update signals for a work item (progress, blockers, metrics, etc.).",
    {
      id: z.string().describe("Work item ID"),
      signals: z.string().describe("JSON string of signal data"),
    },
    safeTool("acmi_work_signal", async ({ id, signals }) => {
      validateKeySegments(id);
      validateJson(signals, "signals");
      await redis("SET", `acmi:work:${id}:signals`, signals);
      return jsonResult({ ok: true, work_id: id });
    })
  );

  // 9. acmi_work_get
  server.tool(
    "acmi_work_get",
    "Read a work item's full context: profile, signals, timeline (last 50), and sessions.",
    {
      id: z.string().describe("Work item ID"),
    },
    safeTool("acmi_work_get", async ({ id }) => {
      validateKeySegments(id);
      const prefix = `acmi:work:${id}`;
      const [profile, signals, timeline, sessions] = await Promise.all([
        redis("GET", `${prefix}:profile`),
        redis("GET", `${prefix}:signals`),
        redis("ZREVRANGE", `${prefix}:timeline`, 0, 49),
        redis("SMEMBERS", `${prefix}:sessions`),
      ]);
      return jsonResult({
        work_id: id,
        profile: profile ? tryParse(profile) : null,
        signals: signals ? tryParse(signals) : null,
        timeline: (timeline || []).map(tryParse),
        sessions: sessions || [],
      });
    })
  );

  // 10. acmi_work_list
  server.tool(
    "acmi_work_list",
    "List all work item IDs.",
    {},
    safeTool("acmi_work_list", async () => {
      const workIds = await readListIds(redis, "acmi:work:list", {
        namespace: "work",
        profilePattern: "acmi:work:*:profile",
        fieldNames: ["work_ids", "ids"],
      });
      return jsonResult({ ok: true, work_ids: workIds });
    })
  );

  // 11. acmi_cat
  server.tool(
    "acmi_cat",
    "Multi-stream event merge view. Combines timeline events from multiple entities, sorted by timestamp. Supports --since filtering.",
    {
      keys: z.array(z.string()).describe("Timeline keys to merge. Use 'thread:name', 'agent:name', or full 'acmi:...:timeline' keys."),
      since: z.string().optional().describe("Time window filter (e.g. '24h', '7d', '30m'). Default: all time."),
      limit: z.number().optional().describe("Max events to return. Default: 50."),
    },
    safeTool("acmi_cat", async ({ keys, since, limit }) => {
      const maxResults = limit || 50;
      const sinceMs = since ? parseSince(since) : 0;
      const targets = keys.map((k) => {
        if (k.startsWith("acmi:")) return k;
        if (k.endsWith(":timeline")) return `acmi:${k}`;
        return `acmi:${k}:timeline`;
      });
      const cutoffMs = sinceMs ? Date.now() - sinceMs : 0;
      const minScore = cutoffMs ? Math.floor(cutoffMs / 1000) : 0;
      const merged = [];
      for (const k of targets) {
        const r = await redis("ZRANGEBYSCORE", k, minScore, "+inf", "WITHSCORES");
        for (const e of parseZWithScores(r)) {
          if (!cutoffMs || e.ts >= cutoffMs) merged.push({ ...e, _source: physKey(redis, k) });
        }
      }
      merged.sort((a, b) => b.ts - a.ts);
      const results = merged.slice(0, maxResults).map((m) => {
        const ts = m.ts;
        const iso = new Date(ts).toISOString().slice(0, 16).replace("T", " ") + "Z";
        const src = m._source.replace(/^acmi:|:timeline$/g, "");
        const d = m.data || {};
        return {
          timestamp: iso,
          source_key: src,
          kind: d.kind || d.source || "?",
          summary: d.summary || d.message || JSON.stringify(d),
        };
      });
      return jsonResult({ ok: true, events: results });
    })
  );

  // 12. acmi_spawn
  server.tool(
    "acmi_spawn",
    "Log an agent session spawn event. Records when an agent starts a new session.",
    {
      agentId: z.string().describe("Agent ID that spawned"),
      sessionId: z.string().optional().describe("Session ID"),
      modelId: z.string().optional().describe("Model ID used for the session"),
    },
    safeTool("acmi_spawn", async ({ agentId, sessionId, modelId }) => {
      validateKeySegments(agentId);
      const ts = Date.now();
      const data = JSON.stringify({
        ts,
        session_id: sessionId || "unknown",
        model_id: modelId || "unknown",
      });
      await redis("ZADD", `acmi:agent:${agentId}:spawns`, ts, data);
      return jsonResult({ ok: true, agent_id: agentId });
    })
  );

  // 13. acmi_bootstrap
  server.tool(
    "acmi_bootstrap",
    "One-shot agent context bundle. Fetches everything a fresh agent session needs: profile, signals, active threads, rollup, recent timeline, and spawns.",
    {
      agentId: z.string().describe("Agent ID to bootstrap"),
    },
    safeTool("acmi_bootstrap", async ({ agentId }) => {
      validateKeySegments(agentId);
      const prefix = `acmi:agent:${agentId}`;
      const [profile, signals, active, rollup, timeline, spawns] = await Promise.all([
        redis("GET", `${prefix}:profile`),
        redis("GET", `${prefix}:signals`),
        readObjectByType(redis, `${prefix}:active_context`),
        redis("GET", `${prefix}:rollup:latest`),
        redis("ZRANGE", `${prefix}:timeline`, 0, -1, "WITHSCORES"),
        redis("ZREVRANGE", `${prefix}:spawns`, 0, 4, "WITHSCORES"),
      ]);
      return jsonResult({
        agent_id: agentId,
        bootstrapped_at: new Date().toISOString(),
        profile: profile ? tryParse(profile) : null,
        signals: signals ? tryParse(signals) : null,
        active_context: active,
        rollup_latest: rollup ? tryParse(rollup) : null,
        timeline_recent: parseZWithScores(timeline).sort((a, b) => b.ts - a.ts).slice(0, 20).map((e) => e.data),
        recent_spawns: parseZWithScores(spawns),
      });
    })
  );

  // 14. acmi_active
  server.tool(
    "acmi_active",
    "Track agent thread engagement. Add/remove threads or list current active threads for an agent.",
    {
      agentId: z.string().describe("Agent ID"),
      action: z.enum(["add", "remove", "list"]).describe("Action: add a thread, remove a thread, or list all active threads"),
      threadKey: z.string().optional().describe("Thread key (required for add/remove)"),
      role: z.string().optional().describe("Role in thread (e.g. 'participant', 'lead'). Default: 'participant'"),
    },
    safeTool("acmi_active", async ({ agentId, action, threadKey, role }) => {
      validateKeySegments(agentId);
      const key = `acmi:agent:${agentId}:active_context`;
      if (action === "add") {
        if (!threadKey) throw new Error("threadKey is required for 'add' action");
        await writeActiveContextEntry(redis, key, threadKey, { role: role || "participant", joined_at: Date.now() });
        return jsonResult({ ok: true, action: "add", threadKey });
      }
      if (action === "remove") {
        if (!threadKey) throw new Error("threadKey is required for 'remove' action");
        await deleteActiveContextEntry(redis, key, threadKey);
        return jsonResult({ ok: true, action: "remove", threadKey });
      }
      const res = await readObjectByType(redis, key);
      return jsonResult({ ok: true, action: "list", threads: res });
    })
  );

  // 15. acmi_rollup_set
  server.tool(
    "acmi_rollup_set",
    "Set the latest rollup snapshot for an agent (acmi:agent:<id>:rollup:latest). Pairs with acmi_bootstrap which reads it.",
    {
      agentId: z.string().describe("Agent ID"),
      rollup: z.string().describe("JSON string of rollup data (cross-session summary, decisions, blockers, etc.)"),
    },
    safeTool("acmi_rollup_set", async ({ agentId, rollup }) => {
      validateKeySegments(agentId);
      validateJson(rollup, "rollup");
      const key = `acmi:agent:${agentId}:rollup:latest`;
      await redis("SET", key, rollup);
      return jsonResult({ ok: true, key: physKey(redis, key) });
    })
  );

  // 16. acmi_delete
  server.tool(
    "acmi_delete",
    "Delete an ACMI key. Refuses protected paths (acmi:registry:*, acmi:notion-sync:*) and any non-acmi:* key. Defaults to dry-run; pass confirm=true to actually delete.",
    {
      key: z.string().describe("Full ACMI key to delete (must start with 'acmi:')"),
      confirm: z.boolean().optional().describe("Must be true to actually delete; otherwise returns dry-run preview. Default: false (dry-run)."),
    },
    safeTool("acmi_delete", async ({ key, confirm }) => {
      if (!key || !key.startsWith("acmi:")) {
        throw new Error("key must start with 'acmi:' (refusing to operate outside ACMI namespace)");
      }
      if (isProtectedKey(key)) {
        throw new Error(`refused: ${key} is a protected path (registry/notion-sync) — protected-paths are never auto-deleted`);
      }
      const exists = await redis("EXISTS", key);
      const type = exists === 1 ? await redis("TYPE", key) : null;
      if (!confirm) {
        return jsonResult({ ok: true, dry_run: true, key, exists: exists === 1, type, hint: "pass confirm=true to actually delete" });
      }
      if (exists !== 1) {
        return jsonResult({ ok: true, dry_run: false, key, deleted: false, reason: "key did not exist" });
      }
      const deleted = await redis("DEL", key);
      return jsonResult({ ok: true, dry_run: false, key, deleted: deleted === 1, type });
    })
  );

  // 17. acmi_search_semantic
  server.tool(
    "acmi_search_semantic",
    "Perform semantic search across fleet coordination history. Finds relevant past events, decisions, and work items based on natural language queries. Returns original ACMI correlationIds for linking.",
    {
      query: z.string().describe("Natural language search query (e.g. 'previous decisions about SSE timeouts')"),
      limit: z.number().optional().describe("Number of results to return. Default: 5."),
    },
    safeTool("acmi_search_semantic", async ({ query, limit }) => {
      // Local-first prototype. Queries ChromaDB via child_process to query_v2.py.
      // Designed for MCP hosts running on the same machine as the Chroma index
      // (Claude Code / Cursor / Cline running on Mikey's laptop). On Vercel, the
      // venv path won't exist — we early-return a clear cloud-fallback error.
      const maxResults = limit || 5;
      console.log(`🔍 [Semantic Search] Query: "${query}" (limit: ${maxResults})`);

      try {
        const fs = await import("node:fs");
        const venvPython = "/Users/michaelshaw/clawd/tools/memory-rag/.venv/bin/python3";
        const searchScript = "/Users/michaelshaw/clawd/tools/memory-rag/query_v2.py";

        if (!fs.existsSync(venvPython) || !fs.existsSync(searchScript)) {
          return jsonResult({
            ok: false,
            error: "Semantic search requires local-runtime context",
            detail: "This tool queries a local ChromaDB via Python child-process. It works when the MCP server is hosted on the same machine as ~/clawd/tools/memory-rag/ (Mikey's laptop). The Vercel container does not have access to the index.",
            hint: "Run the MCP server locally OR migrate impl to a hosted vector API (Upstash Vector, Pinecone) for cloud parity.",
            cloud_fallback: true,
          });
        }

        const { execSync } = await import("node:child_process");
        // query_v2.py argparse uses `-k/--k`, not `--limit`. Fixed 2026-05-12.
        const safeQ = query.replace(/"/g, '\\"');
        const cmd = `${venvPython} ${searchScript} "${safeQ}" --k ${maxResults} --json`;
        const output = execSync(cmd, { encoding: "utf8", timeout: 25000 });
        const results = JSON.parse(output);

        return jsonResult({
          ok: true,
          query,
          results: (Array.isArray(results) ? results : []).map(r => {
            const meta = r.metadata || {};
            return {
              relevance: typeof r.score === "number" ? r.score : (r.similarity || 0),
              summary: r.doc || r.document || r.text || "",
              metadata: {
                date_iso: meta.date_iso || "",
                source: meta.source || "",
                title: meta.title || "",
                project: meta.project || "",
                agent_source: meta.agent_source || "",
                cid: meta.cid || "",
                pcid: meta.pcid || "",
                thread: meta.thread || ""
              },
              link: meta.cid ? `cid:${meta.cid}` : null,
            };
          }),
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: "Semantic index unavailable or search failed",
          detail: String(err.message || err).slice(0, 300),
          hint: "Ensure acmi-chroma-bridge.py has run and the local venv is populated, OR run the MCP server locally.",
        });
      }
    })
  );
}
