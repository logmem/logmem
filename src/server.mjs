// server.mjs — one LogMem server, any transport.
//
//   const lm = createLogmem({ redis, space, surface, sessionId, compat });
//   lm.listTools()            -> tools/list payload (JSON Schema, annotations)
//   await lm.callTool(n, a)   -> MCP CallToolResult (content + structuredContent)
//   lm.attach(mcpServer)      -> register on an @modelcontextprotocol/sdk McpServer
//
// The stdio entry (src/stdio/index.mjs) and the HTTP route (api/mcp.mjs)
// are thin shells around this.

import { applyLimits } from "./core/apply-limits.mjs";
import { createStore, normTs } from "./core/store.mjs";
import { createMirror, mirrorConfigFromEnv } from "./core/mirror.mjs";
import { createShifts } from "./core/session.mjs";
import { TOOLS, keywordRecall } from "./core/tools.mjs";
import { ACMI_TOOLS } from "./compat/acmi-tools.mjs";
import { INSTRUCTIONS } from "./core/instructions.mjs";
import { styleFor } from "./core/style.mjs";
import { RESULT_SCHEMA } from "./core/params.mjs";
import { validateKeySegments } from "./lib/helpers.mjs";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { logRequest, GENERIC_ERROR } from "./http/log.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

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

/** A managed account's recall counts against its plan (Free: 100 a month). Off when there are no limits. */
function limitedRecall(run, limits) {
  if (!limits || typeof limits.beforeRecall !== "function") return run;
  return async (q, n) => {
    const commit = await limits.beforeRecall();
    const floor = limits.historyFloorMs();
    const out = await run(q, n, floor == null ? undefined : { sinceMs: floor });
    await commit();
    return floor == null ? out : { ...out, results: (out.results || []).filter(hit => normTs(hit.ts) >= floor) };
  };
}
export const compatFromEnv = (env = process.env) => ["1", "true", "yes"].includes(String(env.LOGMEM_ACMI_COMPAT || "").toLowerCase());

export function toResult(data, tool) {
  const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { ok: true, value: data };
  // Plain-writing check (docs/spec/WRITING.md): warn on text this call just wrote. Never block.
  // Only write tools. Feed, recall and other reads return text another agent wrote.
  const write = tool?.annotations?.readOnlyHint === false;
  const written = write ? (structured.entry?.summary ?? structured.entries?.[0]?.summary) : undefined;
  if (write && structured.ok !== false && typeof written === "string" && !structured.style) {
    const style = styleFor(written);
    if (style) structured.style = style;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    ...(structured.ok === false ? { isError: true } : {}),
  };
}

const markBackend = (e) => {
  const err = e instanceof Error ? e : new Error(String(e));
  try {
    Object.defineProperty(err, "backend", { value: true, enumerable: false });
  } catch {
    /* frozen error: still an Error, treated as unexpected below */
  }
  return err;
};

/** Programming errors and backend failures are unexpected: their text stays in the server log. */
export const isUnexpected = (e) =>
  !(e instanceof Error) || e.backend === true || e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;

/**
 * The result for a tool that threw. Expected refusals (validation, limits,
 * guards) keep their message, since a model needs it to fix the call. Anything
 * unexpected gets a generic message and a ref; the detail is logged.
 */
export function toolError(e, tool, { sink } = {}) {
  if (!isUnexpected(e)) return { ok: false, error: e.message, tool };
  const ref = randomBytes(6).toString("hex");
  logRequest({ route: "tool", tool, ok: false, err: e, ref }, sink ? { sink } : {});
  return { ok: false, error: GENERIC_ERROR, ref, tool };
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
  // An agent key binds the connection to one agent: other agent ids are refused.
  lockedAgent = null,
  // A managed account's plan limits (src/http/limits.mjs createLimits). Off for the fleet and self-hosted.
  limits = null,
  recall,
  idleMs,
  now,
  mirror: mirrorCfg = { enabled: false, spaces: [] },
  // Pure reads (HTTP): a read-only tool writes nothing. No shift start or
  // last_seen bump (shifts.peek instead of touch) and no mirror drain. The
  // first write starts the shift. Off for stdio, which keeps auto-start.
  pureReads = false,
  // Key that verifies human decisions in the Brief. Default: LOGMEM_DECIDE_SECRET, read at call time.
  decideSecret,
  // Work rules (taxonomy spec): "strict" refuses tasks and decisions off a job and
  // blocked with no reason; "warn" allows them with a warning. Default: LOGMEM_WORK_RULES, else strict.
  workRules = process.env.LOGMEM_WORK_RULES === "warn" ? "warn" : "strict",
} = {}) {
  if (!redis && !live) throw new Error("createLogmem: redis runner required");
  const scope = live ? new AsyncLocalStorage() : null;
  const snapshot = () => scope.getStore() ?? live.current();
  if (live) redis = (...cmd) => snapshot().redis(...cmd);
  // Tag every backend failure, so tool results never carry backend detail
  // (hosts, key names, driver text) back to the client: see toolError.
  const raw = redis;
  redis = async (...cmd) => {
    try {
      return await raw(...cmd);
    } catch (e) {
      throw markBackend(e);
    }
  };
  /** Run fn with one backend snapshot for all of its commands (no-op without `live`). */
  const inScope = (fn) => (live ? scope.run(live.current(), fn) : fn());
  validateKeySegments(space);
  const allowed = spaces && spaces.length ? spaces : [space];
  if (!allowed.includes(space)) throw new Error(`space '${space}' is not in the allowed list`);

  const mirrorOn = !!mirrorCfg.enabled && (mirrorCfg.spaces || []).includes(space);
  const mirror = mirrorOn ? createMirror(redis, space, { now }) : null;
  const store = applyLimits(createStore(redis, { space, compat, mirror }), limits);
  const shifts = createShifts(store, { sessionId: sessionId || `proc-${process.pid}`, surface, defaultAgent, lockedAgent, idleMs, now });
  const ctx = {
    store,
    shifts,
    surface,
    get backend() { return live ? snapshot().kind : backend; },
    spaces: allowed,
    shift: null,
    now: now || Date.now,
    recall: limitedRecall(recall || ((q, n) => keywordRecall(store, q, n)), limits),
    workRules: workRules === "warn" ? "warn" : "strict",
    get decideSecret() { return decideSecret !== undefined ? decideSecret : process.env.LOGMEM_DECIDE_SECRET; },
  };
  const tools = compat ? [...TOOLS, ...ACMI_TOOLS] : [...TOOLS];
  const byName = new Map(tools.map((t) => [t.name, t]));

  function degradedMark(result, tool) {
    if (!live || snapshot().kind !== "memory") return result;
    return toResult({ ...result.structuredContent, degraded: true }, tool);
  }

  /**
   * `validate`: check args against the tool's zod schema first, as the MCP SDK
   * does on stdio (HTTP tools/call has no SDK in front of it). Unknown keys
   * are stripped, like the SDK.
   */
  function callTool(name, args = {}, { validate = false } = {}) {
    return inScope(() => runTool(name, args, validate));
  }

  const schemas = new Map();
  function checkArgs(tool, args) {
    if (args === undefined || args === null) args = {};
    if (typeof args !== "object" || Array.isArray(args)) return { error: `Invalid arguments for ${tool.name}: expected an object` };
    if (!schemas.has(tool.name)) schemas.set(tool.name, z.object(tool.params.shape));
    const p = schemas.get(tool.name).safeParse(args);
    if (p.success) return { args: p.data };
    const why = p.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
    return { error: `Invalid arguments for ${tool.name}: ${why}` };
  }

  async function runTool(name, args = {}, validate = false) {
    const tool = byName.get(name);
    if (!tool) return degradedMark(toResult({ ok: false, error: `unknown tool: ${name}` }));
    if (validate) {
      const c = checkArgs(tool, args);
      if (c.error) return degradedMark(toResult({ ok: false, error: c.error, tool: name }));
      args = c.args;
    }
    const pure = pureReads && tool.annotations?.readOnlyHint === true;
    try {
      let events = [];
      if (pure) {
        ctx.shift = await shifts.peek();
      } else if (!tool.skipTouch) {
        const touched = await shifts.touch(name);
        ctx.shift = touched.shift;
        events = touched.events;
      }
      store.mirrorEvents = [];
      if (mirror && !pure) await mirror.drain().catch(() => {});
      const out = await tool.run(args || {}, ctx);
      if (events.length) out.shift_events = events;
      if (mirror && store.mirrorEvents.length) {
        out.mirror = store.mirrorEvents.includes("failed") ? "failed" : "ok";
      }
      return degradedMark(toResult(out, tool), tool);
    } catch (e) {
      return degradedMark(toResult(toolError(e, name)));
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
