// mcp-tool-defs.mjs — JSON Schema definitions for tools/list responses.
//
// Used by the JSON-RPC dispatcher in api/mcp.mjs (Claude Web direct path).
// The SDK path generates these automatically from zod schemas in mcp-tools.mjs.
// Both must stay in sync (16 tools, same names, same input shapes).
//
// outputSchema + annotations boost Smithery's MCP quality score:
//   - outputSchema: 10.37pt per category, all 16 → +10.37pt
//   - annotations: 5.93pt per category, all 16 → +5.93pt
//
// Annotations follow the MCP spec (readOnlyHint, destructiveHint,
// idempotentHint, openWorldHint, title).

// Smithery configSchema — declares what users must provide via Smithery's
// connect form. The x-from declarations tell Smithery's gateway HOW to
// forward each value to our upstream /api/mcp:
//   - upstashRedisRestUrl → header x-upstash-url
//   - upstashRedisRestToken → header x-upstash-token
//
// Both go as headers (not query params) because the token is secret —
// query params end up in logs / referer headers / browser history. The
// URL goes as a header for symmetry with the token.
//
// Multi-user one-URL flow:
//   1. Each user clicks Install on smithery.ai/servers/madezmediapartners/acmi-mcp
//   2. Smithery's hosted setupUrl renders a form from this schema
//   3. User pastes their own Upstash creds → Smithery stores per-user
//   4. Smithery gives them a connection URL (mcp.smithery.run/...)
//   5. They paste THAT URL into Claude Web (or any MCP client)
//   6. Smithery proxies their requests to /api/mcp with x-upstash-* headers
//      filled in from their stored config
//   7. Each user's tenant scoped to their own creds — no shared state
export const CONFIG_SCHEMA = {
  type: "object",
  required: ["upstashRedisRestUrl", "upstashRedisRestToken"],
  properties: {
    upstashRedisRestUrl: {
      type: "string",
      title: "HTTP Redis REST URL",
      description: "Polar HTTPS exec (canonical): https://acmi-redis-u70402.vm.elestio.app/bridge/exec — no trailing slash. Upstash Cloud REST URLs still work. Do not use native Redis :26379.",
      "x-from": { header: "x-upstash-url" },
    },
    upstashRedisRestToken: {
      type: "string",
      title: "HTTP Redis REST token",
      description: "Polar exec token (canonical: vm-local-bridge) or your Upstash REST token. Treat as a secret.",
      format: "password",
      "x-from": { header: "x-upstash-token" },
    },
    acmiBridgeUrl: {
      type: "string",
      title: "ACMI_BRIDGE_URL (optional alias)",
      description: "Same as HTTP Redis REST URL. Use if your host prefers ACMI_BRIDGE_* names.",
      "x-from": { header: "x-acmi-bridge-url" },
    },
    acmiBridgeToken: {
      type: "string",
      title: "ACMI_BRIDGE_TOKEN (optional alias)",
      description: "Same as HTTP Redis REST token.",
      format: "password",
      "x-from": { header: "x-acmi-bridge-token" },
    },
    acmiDefaultTenant: {
      type: "string",
      title: "ACMI_DEFAULT_TENANT",
      description: "Key prefix tenant. Canonical fleet value: madez. Hosted MCP rewrites acmi:* → acmi:<tenant>:*.",
    },
  },
};

const ok = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    error: { type: "string" },
  },
  description: "Standard tool result envelope. ok=true on success, error string on failure.",
};

export const TOOL_DEFS = [
  {
    name: "acmi_profile",
    description: "Create or update an entity profile in ACMI. Stores arbitrary JSON profile data for an entity (agent, thread, project, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ACMI namespace (e.g. 'agent', 'thread', 'sales')" },
        id: { type: "string", description: "Entity ID within the namespace" },
        profile: { type: "string", description: "JSON string of profile data to store" },
      },
      required: ["namespace", "id", "profile"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, key: { type: "string", description: "Resolved Redis key (acmi:<namespace>:<id>:profile)" } } },
    annotations: { title: "Save Entity Profile", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_signal",
    description: "Update AI signals for an entity. Signals are mutable KV state (mood, priorities, scores, etc.) that changes frequently.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ACMI namespace" },
        id: { type: "string", description: "Entity ID" },
        signals: { type: "string", description: "JSON string of signal data to store" },
      },
      required: ["namespace", "id", "signals"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, key: { type: "string" } } },
    annotations: { title: "Update Entity Signals", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_event",
    description: "Log a timeline event for an entity. The workhorse tool — records timestamped events with source, kind, correlationId, and summary. Follows ACMI Communication Standard v1.1.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ACMI namespace (e.g. 'thread', 'agent', 'work')" },
        id: { type: "string", description: "Entity ID" },
        source: { type: "string", description: "Source of the event (agent name, system, etc.)" },
        summary: { type: "string", description: "Human-readable event summary" },
        kind: { type: "string", description: "Event kind (e.g. 'handoff-complete', 'step-done', 'decision')" },
        correlationId: { type: "string", description: "Correlation ID for tracking across agents/sessions (camelCase)" },
        parentCorrelationId: { type: "string", description: "Parent correlation ID for chain tracking (camelCase). Required when this event continues another." },
        tenant: { type: "string", description: "Tenant override (defaults to madez on this host)" },
      },
      required: ["namespace", "id", "source", "summary"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, key: { type: "string" }, event: { type: "object", description: "The event as written, with ts assigned" } } },
    annotations: { title: "Log Timeline Event", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "acmi_get",
    description: "Fetch complete entity context: profile + signals + recent timeline events (last 10).",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ACMI namespace" },
        id: { type: "string", description: "Entity ID" },
      },
      required: ["namespace", "id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        profile: { type: ["object", "null"] },
        signals: { type: ["object", "null"] },
        timeline_recent: { type: "array", items: { type: "object" } },
      },
      description: "Combined entity view: profile + signals + last 10 timeline events.",
    },
    annotations: { title: "Get Entity Context", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_list",
    description: "List all entity IDs in a namespace.",
    inputSchema: {
      type: "object",
      properties: {
        namespace: { type: "string", description: "ACMI namespace to list" },
      },
      required: ["namespace"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        ids: { type: "array", items: { type: "string" }, description: "Array of entity IDs in the namespace" },
      },
    },
    annotations: { title: "List Namespace Entities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_work_create",
    description: "Create a new work item (cross-session project, task, or idea).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique work item ID" },
        profile: { type: "string", description: "JSON string of work item profile (title, owner, status, etc.)" },
      },
      required: ["id", "profile"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, work_id: { type: "string" } } },
    annotations: { title: "Create Work Item", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_work_event",
    description: "Log a progress event on a work item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item ID" },
        source: { type: "string", description: "Source of the event" },
        summary: { type: "string", description: "Event summary" },
        kind: { type: "string", description: "Event kind (e.g. 'research-brief', 'work-update')" },
        correlationId: { type: "string", description: "Correlation ID for chain tracking" },
        parentCorrelationId: { type: "string", description: "Parent correlation ID for chain tracking" },
        sessionId: { type: "string", description: "Optional session ID to associate" },
      },
      required: ["id", "source", "summary"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, work_id: { type: "string" }, event: { type: "object" } } },
    annotations: { title: "Log Work Item Event", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "acmi_work_signal",
    description: "Update signals for a work item (progress, blockers, metrics, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item ID" },
        signals: { type: "string", description: "JSON string of signal data" },
      },
      required: ["id", "signals"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, work_id: { type: "string" } } },
    annotations: { title: "Update Work Item Signals", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_work_get",
    description: "Read a work item's full context: profile, signals, timeline (last 50), and sessions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Work item ID" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        work_id: { type: "string" },
        profile: { type: ["object", "null"] },
        signals: { type: ["object", "null"] },
        timeline: { type: "array", items: { type: "object" } },
        sessions: { type: "array", items: { type: "string" } },
      },
    },
    annotations: { title: "Get Work Item", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_work_list",
    description: "List all work item IDs.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        work_ids: { type: "array", items: { type: "string" } },
      },
    },
    annotations: { title: "List Work Items", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_cat",
    description: "Multi-stream event merge view. Combines timeline events from multiple entities, sorted by timestamp. Supports --since filtering.",
    inputSchema: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Timeline keys to merge. Use 'thread:name', 'agent:name', or full 'acmi:...:timeline' keys.",
        },
        since: { type: "string", description: "Time window filter (e.g. '24h', '7d', '30m'). Default: all time." },
        limit: { type: "number", description: "Max events to return. Default: 50." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              timestamp: { type: "string" },
              source_key: { type: "string" },
              kind: { type: "string" },
              summary: { type: "string" },
            },
          },
        },
      },
    },
    annotations: { title: "Merge Timelines", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_spawn",
    description: "Log an agent session spawn event. Records when an agent starts a new session.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID that spawned" },
        sessionId: { type: "string", description: "Session ID" },
        modelId: { type: "string", description: "Model ID used for the session" },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, agent_id: { type: "string" } } },
    annotations: { title: "Log Agent Spawn", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "acmi_bootstrap",
    description: "One-shot agent context bundle. Fetches everything a fresh agent session needs: profile, signals, active threads, rollup, recent timeline, and spawns.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID to bootstrap" },
      },
      required: ["agentId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        agent_id: { type: "string" },
        bootstrapped_at: { type: "string", format: "date-time" },
        profile: { type: ["object", "null"] },
        signals: { type: ["object", "null"] },
        active_context: { type: "object" },
        rollup_latest: { type: ["object", "null"] },
        timeline_recent: { type: "array" },
        recent_spawns: { type: "array" },
      },
    },
    annotations: { title: "Bootstrap Agent Context", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_active",
    description: "Track agent thread engagement. Add/remove threads or list current active threads for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID" },
        action: { type: "string", enum: ["add", "remove", "list"], description: "Action: add a thread, remove a thread, or list all active threads" },
        threadKey: { type: "string", description: "Thread key (required for add/remove)" },
        role: { type: "string", description: "Role in thread (e.g. 'participant', 'lead'). Default: 'participant'" },
      },
      required: ["agentId", "action"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, action: { type: "string" }, threadKey: { type: "string" } } },
    annotations: { title: "Manage Active Threads", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_rollup_set",
    description: "Set the latest rollup snapshot for an agent (acmi:agent:<id>:rollup:latest). Pairs with acmi_bootstrap which reads it.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent ID" },
        rollup: { type: "string", description: "JSON string of rollup data (cross-session summary, decisions, blockers, etc.)" },
      },
      required: ["agentId", "rollup"],
      additionalProperties: false,
    },
    outputSchema: { ...ok, properties: { ...ok.properties, key: { type: "string" } } },
    annotations: { title: "Set Agent Rollup", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_delete",
    description: "Delete an ACMI key. Refuses protected paths (acmi:registry:*, acmi:notion-sync:*) and any non-acmi:* key. Defaults to dry-run; pass confirm=true to actually delete.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Full ACMI key to delete (must start with 'acmi:')" },
        confirm: { type: "boolean", description: "Must be true to actually delete; otherwise returns dry-run preview. Default: false (dry-run)." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        dry_run: { type: "boolean" },
        key: { type: "string" },
        deleted: { type: "boolean" },
        exists: { type: "boolean" },
        type: { type: ["string", "null"] },
      },
    },
    annotations: { title: "Delete ACMI Key", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "acmi_search_semantic",
    description: "Perform semantic search across fleet coordination history. Finds relevant past events, decisions, and work items based on natural language queries. Returns original ACMI correlationIds for linking.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query (e.g. 'previous decisions about SSE timeouts')" },
        limit: { type: "number", description: "Number of results to return. Default: 5." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        query: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              relevance: { type: "number" },
              summary: { type: "string" },
              metadata: { type: "object" },
              link: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    annotations: { title: "Semantic Fleet Search", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
