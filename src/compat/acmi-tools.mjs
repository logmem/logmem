// acmi-tools.mjs — ACMI compatibility mode (LOGMEM_ACMI_COMPAT=1).
//
// Exposes the acmi_* tool names with ACMI-shaped inputs and outputs, backed
// by the LogMem store:
//   - writes land in lm:{space}:* (LogMem shape: trail/origin/by/space, LogMem kinds)
//   - reads merge lm:{space}:* with legacy acmi:{space}:* and translate back
//     to ACMI shape (correlationId/parentCorrelationId/source, ACMI kinds)
// so an unmodified ACMI agent keeps working against a LogMem server.

import { params } from "../core/params.mjs";
import { parseRef } from "../core/keys.mjs";
import { entryFromAcmi, entryToAcmi, nsFromAcmi } from "../core/vocab.mjs";
import { validateKeySegments, validateJson } from "../lib/helpers.mjs";
import { SLOTS, checkAgentId } from "../core/keys.mjs";
import { HUMAN_ONLY, isDecidedKind, capEntry, capJson } from "../core/tools.mjs";

/** Rollups are cross-session summaries; they get more room than one entry's payload. */
const ROLLUP_MAX = 64 * 1024;

/** ACMI events go through the same rules as logmem_note: no agent-written decisions, size caps. */
function guardEvent({ kind, summary, correlationId, parentCorrelationId }) {
  if (isDecidedKind(kind)) return { ok: false, error: HUMAN_ONLY };
  capEntry({ summary, trail: correlationId, origin: parentCorrelationId });
  return null;
}

/** Validate key segments, and the id as an agent id when the namespace is agent. */
function checkEntity(namespace, id) {
  validateKeySegments(namespace, id);
  if (nsFromAcmi(namespace) === "agent") checkAgentId(id, "id");
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const json = (s) => JSON.parse(s);

function parseSince(s) {
  const m = String(s || "").match(/^(\d+)([hdm])$/);
  if (!m) return 0;
  return Number(m[1]) * { h: 3600e3, d: 86400e3, m: 60e3 }[m[2]];
}

/** ACMI event args -> stored LogMem entry */
async function appendAcmi(store, ns, id, ev) {
  return store.append(ns, id, entryFromAcmi({ ts: Date.now(), ...ev }));
}

const toAcmiList = (entries) => entries.map(entryToAcmi);

/** Map an ACMI key (acmi:[tenant:]ns:id:slot) onto its lm:* twin. */
export function acmiKeyToLm(key, space) {
  const parts = String(key).split(":");
  if (parts[0] !== "acmi") return null;
  let rest = parts.slice(1);
  if (rest[0] === space) rest = rest.slice(1);
  if (rest.length < 3) return null;
  const [ns, id, ...slotParts] = rest;
  const acmiSlot = slotParts.join(":");
  const slot = Object.entries(SLOTS).find(([, d]) => d.acmi === acmiSlot)?.[0];
  if (!slot) return null;
  return `lm:${space}:${nsFromAcmi(ns)}:${id}:${slot}`;
}

export const ACMI_TOOLS = [
  {
    name: "acmi_profile",
    description: "Create or update an entity profile in ACMI. Stores arbitrary JSON profile data for an entity (agent, thread, project, etc.).",
    params: params({
      namespace: { type: "string", desc: "ACMI namespace (e.g. 'agent', 'thread', 'sales')" },
      id: { type: "string", desc: "Entity ID within the namespace" },
      profile: { type: "string", desc: "JSON string of profile data to store" },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ namespace, id, profile }, { store }) {
      checkEntity(namespace, id);
      validateJson(profile, "profile");
      capJson("profile", profile);
      const ns = nsFromAcmi(namespace);
      await store.setWho(ns, id, json(profile));
      return { ok: true, key: store.key(ns, id, "who") };
    },
  },
  {
    name: "acmi_signal",
    description: "Update AI signals for an entity. Signals are mutable KV state (mood, priorities, scores, etc.) that changes frequently.",
    params: params({
      namespace: { type: "string", desc: "ACMI namespace" },
      id: { type: "string", desc: "Entity ID" },
      signals: { type: "string", desc: "JSON string of signal data to store" },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ namespace, id, signals }, { store }) {
      checkEntity(namespace, id);
      validateJson(signals, "signals");
      capJson("signals", signals);
      const ns = nsFromAcmi(namespace);
      await store.replaceNow(ns, id, json(signals));
      return { ok: true, key: store.key(ns, id, "now") };
    },
  },
  {
    name: "acmi_event",
    description: "Log a timeline event for an entity. The workhorse tool — records timestamped events with source, kind, correlationId, and summary. Follows ACMI Communication Standard v1.1.",
    params: params({
      namespace: { type: "string", desc: "ACMI namespace (e.g. 'thread', 'agent', 'work')" },
      id: { type: "string", desc: "Entity ID" },
      source: { type: "string", desc: "Source of the event (agent name, system, etc.)" },
      summary: { type: "string", desc: "Human-readable event summary" },
      kind: { type: "string", desc: "Event kind (e.g. 'handoff-complete', 'step-done', 'decision')", optional: true },
      correlationId: { type: "string", desc: "Correlation ID for tracking across agents/sessions (camelCase)", optional: true },
      parentCorrelationId: { type: "string", desc: "Parent correlation ID for chain tracking (camelCase)", optional: true },
      tenant: { type: "string", desc: "Ignored: this connection is bound to one space", optional: true },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ namespace, id, source, summary, kind, correlationId, parentCorrelationId }, { store, surface }) {
      checkEntity(namespace, id);
      const refused = guardEvent({ kind, summary, correlationId, parentCorrelationId });
      if (refused) return refused;
      const ns = nsFromAcmi(namespace);
      const ev = { source, summary, via: surface };
      if (kind) ev.kind = kind;
      if (correlationId) ev.correlationId = correlationId;
      if (parentCorrelationId) ev.parentCorrelationId = parentCorrelationId;
      const stored = await appendAcmi(store, ns, id, ev);
      return { ok: true, key: store.key(ns, id, "log"), event: entryToAcmi(stored) };
    },
  },
  {
    name: "acmi_get",
    description: "Fetch complete entity context: profile + signals + recent timeline events (last 10).",
    params: params({
      namespace: { type: "string", desc: "ACMI namespace" },
      id: { type: "string", desc: "Entity ID" },
    }),
    annotations: READ,
    skipTouch: true,
    async run({ namespace, id }, { store }) {
      checkEntity(namespace, id);
      const ns = nsFromAcmi(namespace);
      const [profile, signals, log] = await Promise.all([
        store.getWho(ns, id),
        store.getNow(ns, id),
        store.readLog(ns, id, { reverse: true, limit: 10 }),
      ]);
      return { profile, signals: Object.keys(signals).length ? signals : null, timeline_recent: toAcmiList(log) };
    },
  },
  {
    name: "acmi_list",
    description: "List all entity IDs in a namespace.",
    params: params({ namespace: { type: "string", desc: "ACMI namespace to list" } }),
    annotations: READ,
    skipTouch: true,
    async run({ namespace }, { store }) {
      validateKeySegments(namespace);
      return { ok: true, ids: await store.list(nsFromAcmi(namespace)) };
    },
  },
  {
    name: "acmi_work_create",
    description: "Create a new work item (cross-session project, task, or idea).",
    params: params({
      id: { type: "string", desc: "Unique work item ID" },
      profile: { type: "string", desc: "JSON string of work item profile (title, owner, status, etc.)" },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ id, profile }, { store }) {
      validateKeySegments(id);
      validateJson(profile, "profile");
      capJson("profile", profile);
      await store.setWho("job", id, json(profile));
      return { ok: true, work_id: id };
    },
  },
  {
    name: "acmi_work_event",
    description: "Log a progress event on a work item.",
    params: params({
      id: { type: "string", desc: "Work item ID" },
      source: { type: "string", desc: "Source of the event" },
      summary: { type: "string", desc: "Event summary" },
      kind: { type: "string", desc: "Event kind", optional: true },
      correlationId: { type: "string", desc: "Correlation ID for chain tracking", optional: true },
      parentCorrelationId: { type: "string", desc: "Parent correlation ID for chain tracking", optional: true },
      sessionId: { type: "string", desc: "Optional session ID to associate", optional: true },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ id, source, summary, kind, correlationId, parentCorrelationId, sessionId }, { store, surface }) {
      validateKeySegments(id);
      const refused = guardEvent({ kind, summary, correlationId, parentCorrelationId });
      if (refused) return refused;
      const ev = { source, summary, via: surface };
      if (kind) ev.kind = kind;
      if (correlationId) ev.correlationId = correlationId;
      if (parentCorrelationId) ev.parentCorrelationId = parentCorrelationId;
      if (sessionId) ev.session_id = sessionId;
      const stored = await appendAcmi(store, "job", id, ev);
      if (sessionId) await store.addJobSession(id, sessionId);
      return { ok: true, work_id: id, event: entryToAcmi(stored) };
    },
  },
  {
    name: "acmi_work_signal",
    description: "Update signals for a work item (progress, blockers, metrics, etc.).",
    params: params({
      id: { type: "string", desc: "Work item ID" },
      signals: { type: "string", desc: "JSON string of signal data" },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ id, signals }, { store }) {
      validateKeySegments(id);
      validateJson(signals, "signals");
      capJson("signals", signals);
      await store.replaceNow("job", id, json(signals));
      return { ok: true, work_id: id };
    },
  },
  {
    name: "acmi_work_get",
    description: "Read a work item's full context: profile, signals, timeline (last 50), and sessions.",
    params: params({ id: { type: "string", desc: "Work item ID" } }),
    annotations: READ,
    skipTouch: true,
    async run({ id }, { store }) {
      validateKeySegments(id);
      const [profile, signals, log, sessions] = await Promise.all([
        store.getWho("job", id),
        store.getNow("job", id),
        store.readLog("job", id, { reverse: true, limit: 50 }),
        store.jobSessions(id),
      ]);
      return { work_id: id, profile, signals: Object.keys(signals).length ? signals : null, timeline: toAcmiList(log), sessions: sessions || [] };
    },
  },
  {
    name: "acmi_work_list",
    description: "List all work item IDs.",
    params: params({}),
    annotations: READ,
    skipTouch: true,
    async run(_a, { store }) {
      return { ok: true, work_ids: await store.list("job") };
    },
  },
  {
    name: "acmi_cat",
    description: "Multi-stream event merge view. Combines timeline events from multiple entities, sorted by timestamp. Supports --since filtering.",
    params: params({
      keys: { type: "strings", desc: "Timeline keys to merge. Use 'thread:name', 'agent:name', or full 'acmi:...:timeline' keys." },
      since: { type: "string", desc: "Time window filter (e.g. '24h', '7d', '30m'). Default: all time.", optional: true },
      limit: { type: "number", desc: "Max events to return. Default: 50.", optional: true },
    }),
    annotations: READ,
    skipTouch: true,
    async run({ keys, since, limit }, { store }) {
      const sinceMs = since ? Date.now() - parseSince(since) : undefined;
      const merged = [];
      for (const raw of keys) {
        const ref = String(raw)
          .replace(/^acmi:/, "")
          .replace(new RegExp(`^${store.space}:`), "")
          .replace(/:timeline$/, "");
        const { ns, id } = parseRef(ref);
        for (const e of await store.readLog(ns, id, { sinceMs })) merged.push({ e, src: `${ns}:${id}` });
      }
      merged.sort((a, b) => b.e.ts - a.e.ts);
      const events = merged.slice(0, limit || 50).map(({ e, src }) => {
        const a = entryToAcmi(e);
        return {
          timestamp: new Date(e.ts).toISOString().slice(0, 16).replace("T", " ") + "Z",
          source_key: src.replace(/^channel:/, "thread:").replace(/^job:/, "work:"),
          kind: a.kind || a.source || "?",
          summary: a.summary || JSON.stringify(a),
        };
      });
      return { ok: true, events };
    },
  },
  {
    name: "acmi_spawn",
    description: "Log an agent session spawn event. Records when an agent starts a new session.",
    params: params({
      agentId: { type: "string", desc: "Agent ID that spawned" },
      sessionId: { type: "string", desc: "Session ID", optional: true },
      modelId: { type: "string", desc: "Model ID used for the session", optional: true },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ agentId, sessionId, modelId }, { store }) {
      validateKeySegments(agentId);
      checkAgentId(agentId, "agentId");
      await store.addShift(agentId, { ts: Date.now(), session_id: sessionId || "unknown", model_id: modelId || "unknown" });
      return { ok: true, agent_id: agentId };
    },
  },
  {
    name: "acmi_bootstrap",
    description: "One-shot agent context bundle. Fetches everything a fresh agent session needs: profile, signals, active threads, rollup, recent timeline, and spawns.",
    params: params({
      agentId: { type: "string", desc: "Agent ID to bootstrap" },
      tenant: { type: "string", desc: "Ignored: this connection is bound to one space", optional: true },
    }),
    annotations: READ,
    skipTouch: true,
    async run({ agentId }, { store }) {
      validateKeySegments(agentId);
      checkAgentId(agentId, "agentId");
      const [profile, signals, active, rollup, log, spawns] = await Promise.all([
        store.getWho("agent", agentId),
        store.getNow("agent", agentId),
        store.follows(agentId),
        store.getRecap(agentId),
        store.readLog("agent", agentId, { reverse: true, limit: 20 }),
        store.recentShifts(agentId, 5),
      ]);
      const activeAcmi = Object.fromEntries(
        Object.entries(active).map(([k, v]) => [k.replace(/^channel:/, "").replace(/^job:/, "work:"), v]),
      );
      return {
        agent_id: agentId,
        tenant: store.space,
        bootstrapped_at: new Date().toISOString(),
        profile,
        signals: Object.keys(signals).length ? signals : null,
        active_context: activeAcmi,
        rollup_latest: rollup,
        timeline_recent: toAcmiList(log),
        recent_spawns: spawns,
      };
    },
  },
  {
    name: "acmi_active",
    description: "Track agent thread engagement. Add/remove threads or list current active threads for an agent.",
    params: params({
      agentId: { type: "string", desc: "Agent ID" },
      action: { enum: ["add", "remove", "list"], desc: "Action: add a thread, remove a thread, or list all active threads" },
      threadKey: { type: "string", desc: "Thread key (required for add/remove)", optional: true },
      role: { type: "string", desc: "Role in thread (e.g. 'participant', 'lead'). Default: 'participant'", optional: true },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ agentId, action, threadKey, role }, { store }) {
      validateKeySegments(agentId);
      checkAgentId(agentId, "agentId");
      const ref = threadKey ? (threadKey.includes(":") ? threadKey.replace(/^thread:/, "channel:").replace(/^work:/, "job:") : `channel:${threadKey}`) : null;
      if (action === "add") {
        if (!ref) throw new Error("threadKey is required for 'add' action");
        await store.follow(agentId, ref, { role: role || "participant", joined_at: Date.now() });
        return { ok: true, action, threadKey };
      }
      if (action === "remove") {
        if (!ref) throw new Error("threadKey is required for 'remove' action");
        await store.unfollow(agentId, ref);
        return { ok: true, action, threadKey };
      }
      return { ok: true, action: "list", threads: await store.follows(agentId) };
    },
  },
  {
    name: "acmi_rollup_set",
    description: "Set the latest rollup snapshot for an agent (acmi:agent:<id>:rollup:latest). Pairs with acmi_bootstrap which reads it.",
    params: params({
      agentId: { type: "string", desc: "Agent ID" },
      rollup: { type: "string", desc: "JSON string of rollup data (cross-session summary, decisions, blockers, etc.)" },
    }),
    annotations: WRITE,
    skipTouch: true,
    async run({ agentId, rollup }, { store }) {
      validateKeySegments(agentId);
      checkAgentId(agentId, "agentId");
      validateJson(rollup, "rollup");
      capJson("rollup", rollup, ROLLUP_MAX);
      await store.setRecap(agentId, json(rollup));
      return { ok: true, key: store.key("agent", agentId, "recap") };
    },
  },
  {
    name: "acmi_delete",
    description: "Delete an ACMI key. Refuses protected paths and anything outside this space. Defaults to dry-run; pass confirm=true to actually delete. ACMI keys are mapped to their lm:* equivalents.",
    params: params({
      key: { type: "string", desc: "Full ACMI key ('acmi:...') or LogMem key ('lm:<space>:...')" },
      confirm: { type: "boolean", desc: "Must be true to actually delete; otherwise returns dry-run preview.", optional: true },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    skipTouch: true,
    async run({ key, confirm }, { store }) {
      const target = key.startsWith("acmi:") ? acmiKeyToLm(key, store.space) : key;
      if (!target) throw new Error(`cannot map ${key} to a LogMem key; legacy acmi:* keys are never deleted from compat mode`);
      const r = await store.remove(target, { confirm: confirm === true });
      return { ok: true, requested: key, ...r, deleted: r.removed };
    },
  },
  {
    name: "acmi_search_semantic",
    description: "Perform semantic search across fleet coordination history. Finds relevant past events, decisions, and work items based on natural language queries. Returns original ACMI correlationIds for linking.",
    params: params({
      query: { type: "string", desc: "Natural language search query" },
      limit: { type: "number", desc: "Number of results to return. Default: 5.", optional: true },
    }),
    annotations: READ,
    skipTouch: true,
    async run({ query, limit }, ctx) {
      const r = await ctx.recall(query, limit || 5);
      return { ok: true, query, ...r, results: r.results.map((x) => ({ ...x, link: x.trail ? `cid:${x.trail}` : null })) };
    },
  },
  {
    name: "acmi_tenant_list",
    description: "List tenants this connection can use.",
    params: params({}),
    annotations: READ,
    skipTouch: true,
    async run(_a, ctx) {
      return { ok: true, default: ctx.store.space, tenants: ctx.spaces };
    },
  },
  {
    name: "acmi_mcp_status",
    description: "Report ACMI MCP server status: connection mode, tenant, degraded state.",
    params: params({}),
    annotations: READ,
    skipTouch: true,
    async run(_a, ctx) {
      return { ok: true, server: "logmem", acmi_compat: true, mode: ctx.backend, tenant: ctx.store.space, degraded: ctx.backend === "memory" };
    },
  },
];
