// server.mjs — one LogMem server, any transport.
//
//   const lm = createLogmem({ redis, space, surface, sessionId, compat });
//   lm.listTools()            -> tools/list payload (JSON Schema, annotations)
//   await lm.callTool(n, a)   -> MCP CallToolResult (content + structuredContent)
//   lm.attach(mcpServer)      -> register on an @modelcontextprotocol/sdk McpServer
//
// The stdio entry (src/stdio/index.mjs) and the HTTP route (api/mcp.mjs)
// are thin shells around this.

import { createStore } from "./core/store.mjs";
import { createMirror, mirrorConfigFromEnv } from "./core/mirror.mjs";
import { createShifts } from "./core/session.mjs";
import { TOOLS, keywordRecall } from "./core/tools.mjs";
import { ACMI_TOOLS } from "./compat/acmi-tools.mjs";
import { INSTRUCTIONS } from "./core/instructions.mjs";
import { RESULT_SCHEMA } from "./core/params.mjs";
import { validateKeySegments } from "./lib/helpers.mjs";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

/** package.json version, read at load time. readFileSync(new URL(...)) is traced by Vercel's bundler. */
function readPkgVersion() {
  try {
    const v = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    return typeof v === "string" && v ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PKG_VERSION = readPkgVersion();

/** package.json version, plus "+<sha7>" build metadata on Vercel builds. */
export function versionString(env = process.env, base = PKG_VERSION) {
  const sha = String(env?.VERCEL_GIT_COMMIT_SHA || "").trim().slice(0, 7);
  return sha ? `${base}+${sha}` : base;
}

export const SERVER_INFO = { name: "logmem", version: versionString() };
export { INSTRUCTIONS };

export { mirrorConfigFromEnv };
export const compatFromEnv = (env = process.env) => ["1", "true", "yes"].includes(String(env.LOGMEM_ACMI_COMPAT || "").toLowerCase());

export function toResult(data) {
  const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { ok: true, value: data };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    ...(structured.ok === false ? { isError: true } : {}),
  };
}

export function createLogmem({
  redis,
  backend = "unknown",
  // Switchable backend (stdio degraded mode): { current() -> { kind, redis } }.
  // One snapshot of current() is taken per tool call and used for every command
  // in that call, so a call never mixes the in-memory store and the real
  // backend. While the snapshot is "memory", results carry degraded:true.
  live,
  space,
  spaces,
  compat = false,
  surface = "unknown",
  sessionId,
  defaultAgent,
  recall,
  idleMs,
  now,
  mirror: mirrorCfg = { enabled: false, spaces: [] },
} = {}) {
  if (!redis && !live) throw new Error("createLogmem: redis runner required");
  const scope = live ? new AsyncLocalStorage() : null;
  const snapshot = () => scope.getStore() ?? live.current();
  if (live) redis = (...cmd) => snapshot().redis(...cmd);
  /** Run fn with one backend snapshot for all of its commands (no-op without `live`). */
  const inScope = (fn) => (live ? scope.run(live.current(), fn) : fn());
  validateKeySegments(space);
  const allowed = spaces && spaces.length ? spaces : [space];
  if (!allowed.includes(space)) throw new Error(`space '${space}' is not in the allowed list`);

  const mirrorOn = !!mirrorCfg.enabled && (mirrorCfg.spaces || []).includes(space);
  const mirror = mirrorOn ? createMirror(redis, space, { now }) : null;
  const store = createStore(redis, { space, compat, mirror });
  const shifts = createShifts(store, { sessionId: sessionId || `proc-${process.pid}`, surface, defaultAgent, idleMs, now });
  const ctx = {
    store,
    shifts,
    surface,
    get backend() { return live ? snapshot().kind : backend; },
    spaces: allowed,
    shift: null,
    now: now || Date.now,
    recall: recall || ((q, n) => keywordRecall(store, q, n)),
  };
  const tools = compat ? [...TOOLS, ...ACMI_TOOLS] : [...TOOLS];
  const byName = new Map(tools.map((t) => [t.name, t]));

  function degradedMark(result) {
    if (!live || snapshot().kind !== "memory") return result;
    return toResult({ ...result.structuredContent, degraded: true });
  }

  function callTool(name, args = {}) {
    return inScope(() => runTool(name, args));
  }

  async function runTool(name, args = {}) {
    const tool = byName.get(name);
    if (!tool) return degradedMark(toResult({ ok: false, error: `unknown tool: ${name}` }));
    try {
      let events = [];
      if (!tool.skipTouch) {
        const touched = await shifts.touch(name);
        ctx.shift = touched.shift;
        events = touched.events;
      }
      store.mirrorEvents = [];
      if (mirror) await mirror.drain().catch(() => {});
      const out = await tool.run(args || {}, ctx);
      if (events.length) out.shift_events = events;
      if (mirror && store.mirrorEvents.length) {
        out.mirror = store.mirrorEvents.includes("failed") ? "failed" : "ok";
      }
      return degradedMark(toResult(out));
    } catch (e) {
      return degradedMark(toResult({ ok: false, error: e.message, tool: name }));
    }
  }

  function listTools() {
    return tools.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.params.jsonSchema,
      outputSchema: RESULT_SCHEMA,
      annotations: { title: t.title || t.name, ...t.annotations },
    }));
  }

  function attach(mcp) {
    for (const t of tools) {
      mcp.registerTool(
        t.name,
        { title: t.title, description: t.description, inputSchema: t.params.shape, annotations: t.annotations },
        (args) => callTool(t.name, args),
      );
    }
    return mcp;
  }

  return { store, shifts, ctx, tools, callTool, listTools, attach, inScope, instructions: INSTRUCTIONS };
}
