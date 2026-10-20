// api/mcp.mjs — LogMem over Streamable HTTP (POST request/reply), Vercel Node runtime.
//
// One hand-rolled JSON-RPC dispatcher serves both client styles:
//   - Accept: text/event-stream  -> reply framed as one SSE message
//   - Accept: application/json   -> plain JSON (Claude Web form, curl)
// No long-lived GET streams (serverless 60s cap), same as the ACMI route.
//
// Sessions: initialize returns an Mcp-Session-Id that encodes the client's
// surface ("<surface>.<uuid>"). Clients echo it, so shifts (auto Start /
// auto Recap / persona switch) survive across stateless invocations.

import { randomUUID, createHash } from "node:crypto";
import { createLogmem, compatFromEnv, mirrorConfigFromEnv, toResult, toolError, SERVER_INFO, INSTRUCTIONS } from "../src/server.mjs";

/** A failure building the server instance (backend, config) is never shown to the client verbatim. */
const markUnexpected = (e) => {
  const err = e instanceof Error ? e : new Error(String(e));
  try {
    Object.defineProperty(err, "backend", { value: true, enumerable: false });
  } catch {
    /* ignore */
  }
  return err;
};
import { fromDescriptor } from "../src/lib/backend.mjs";
import { resolveAuth, decodeConfig, wwwAuthenticate, bearerOf } from "../src/http/auth.mjs";
import { sendServerError } from "../src/http/log.mjs";
import { createJail } from "../src/http/jail.mjs";
import { createLimits } from "../src/http/limits.mjs";
import { getTenant } from "../cloud/tenants/index.mjs";
import { SCOPE_WRITE, ALL_SCOPES } from "../src/http/issuer.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

const PROTOCOL_VERSION = "2025-06-18";
const PUBLIC = new Set(["initialize", "notifications/initialized", "initialized", "tools/list", "resources/list", "prompts/list", "ping"]);

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "http";

function surfaceFromSession(sid) {
  const i = String(sid || "").indexOf(".");
  return i > 0 ? sid.slice(0, i) : null;
}

/** Stable fallback session id for clients that never echo Mcp-Session-Id. */
function fallbackSession(req, auth) {
  const basis = [auth.source, auth.sub || "", bearerOf(req) || "", req.headers["user-agent"] || ""].join("|");
  return `${slug(req.headers["x-logmem-surface"] || "http")}.${createHash("sha256").update(basis).digest("hex").slice(0, 24)}`;
}

function send(res, wantsSSE, reply, headers = {}) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (reply === null) {
    res.status(202).end();
    return;
  }
  if (wantsSSE) {
    res.status(200).setHeader("Content-Type", "text/event-stream");
    res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
  } else {
    res.status(200).setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
  }
}

/** Bind session state to the credential: an agent key's sessions never share a record with any other caller. */
export function scopedSessionId(sessionId, auth) {
  return (auth?.source === "agent-key" || auth?.source === "managed") && auth.keyId ? `${sessionId}~${auth.keyId}` : sessionId;
}

const tenantCache = new Map(); // tenant id -> { at, tenant }
const TENANT_TTL_MS = 60_000;

/** A managed account's LogMem: jailed to its space, locked to its agent, with its plan's limits. */
export async function buildManaged({ redis, auth, sessionId, now = Date.now }) {
  const t = await getTenant(redis, auth.tenant);
  if (!t || t.status !== "active") throw new Error("This LogMem account is paused.");
  return createLogmem({
    redis: createJail(redis, auth.tenant),
    backend: "native",
    space: auth.space,
    spaces: [auth.space],
    compat: false,
    surface: surfaceFromSession(sessionId) || "http",
    sessionId,
    defaultAgent: auth.agent,
    lockedAgent: auth.agent,
    mirror: { enabled: false, spaces: [] },
    limits: createLimits({ redis, tenant: auth.tenant, plan: t.plan, now }),
    pureReads: true,
  });
}
export const __clearTenantCacheForTests = () => tenantCache.clear();

export function buildInstance({ redis, kind, auth, sessionId, env = process.env }) {
  // Token-bound: exactly one space. Server's own Redis (break-glass): only the
  // spaces the deploy allows. Caller-supplied Redis: the caller owns it, so
  // whatever space they name.
  let spaces;
  if (auth.pinned) spaces = [auth.space];
  else if (auth.source === "env-authed") spaces = (env.LOGMEM_SPACES || env.LOGMEM_SPACE || "madez").split(",").map((s) => s.trim()).filter(Boolean);
  else spaces = [auth.space];
  return createLogmem({
    redis,
    backend: kind,
    space: auth.space,
    spaces,
    compat: compatFromEnv(env),
    surface: surfaceFromSession(sessionId) || "http",
    sessionId,
    defaultAgent: auth.agent || env.LOGMEM_AGENT,
    lockedAgent: auth.agent || null,
    mirror: mirrorConfigFromEnv(env),
    pureReads: true,
  });
}

/**
 * true when an OAuth token without logmem:write calls a tool that is not
 * read only (unknown tools included). Agent keys and break-glass carry no
 * scopes and are not limited here.
 */
export function insufficientScope(auth, msg, toolDefs) {
  if (msg?.method !== "tools/call" || !Array.isArray(auth?.scopes) || auth.scopes.includes(SCOPE_WRITE)) return false;
  const tool = toolDefs.find((t) => t.name === msg.params?.name);
  return tool?.annotations?.readOnlyHint !== true;
}

export async function dispatch(msg, { lmFactory, toolDefs }) {
  const { id = null, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "initialized":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolDefs() });
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    case "tools/call": {
      let lm;
      try {
        lm = await lmFactory();
      } catch (e) {
        return ok(toResult(toolError(markUnexpected(e), params?.name)));
      }
      return ok(await lm.callTool(params?.name, params?.arguments, { validate: true }));
    }
    default:
      return fail(-32601, `Unknown method: ${method}`);
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-LogMem-Space, X-LogMem-Surface");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.status(204).end();

  const wantsSSE = String(req.headers.accept || "").toLowerCase().includes("text/event-stream");
  const toolDefs = () => createLogmem({ redis: async () => null, space: "madez", compat: compatFromEnv(), sessionId: "list" }).listTools();

  if (req.method === "GET") {
    if (wantsSSE) return res.status(405).json({ error: "GET streams not supported; POST JSON-RPC instead" });
    return res.status(200).json({ ...SERVER_INFO, protocolVersion: PROTOCOL_VERSION, transport: "streamable-http", toolCount: toolDefs().length, acmi_compat: compatFromEnv() });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let cfg;
    try {
      cfg = decodeConfig(req);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const msg = req.body;
    const auth = await resolveAuth(req, cfg);
    const b = auth.backend && fromDescriptor(auth.backend);
    if (!b && !PUBLIC.has(msg?.method)) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate(req, { error: auth.error }));
      return res.status(401).json({ error: "authentication required for tool calls", hint: "OAuth 2.1 + PKCE via /.well-known/oauth-authorization-server, or ?config=<base64> with restUrl/restToken." });
    }
    // A read-only grant (logmem:read) may call read tools only. 403 lets the
    // client ask the person for logmem:write (MCP step-up authorization).
    if (insufficientScope(auth, msg, toolDefs())) {
      res.setHeader("WWW-Authenticate", wwwAuthenticate(req, { error: "insufficient_scope", scope: ALL_SCOPES }));
      return res.status(403).json({ error: "insufficient_scope", hint: "This connection can only read. Reconnect and allow logmem:write to write." });
    }

    const headers = { "X-LogMem-Cred-Source": auth.source, "X-LogMem-Space": auth.space };
    let sessionId = req.headers["mcp-session-id"];
    if (msg?.method === "initialize") {
      sessionId = `${slug(msg.params?.clientInfo?.name)}.${randomUUID()}`;
      headers["Mcp-Session-Id"] = sessionId;
    }
    if (!sessionId) sessionId = fallbackSession(req, auth);
    sessionId = scopedSessionId(sessionId, auth);

    const reply = await dispatch(msg, {
      toolDefs,
      lmFactory: async () => (auth.source === "managed" ? buildManaged({ redis: b.redis, auth, sessionId }) : buildInstance({ redis: b.redis, kind: b.kind, auth, sessionId })),
    });
    return send(res, wantsSSE, reply, headers);
  } catch (e) {
    sendServerError(res, "/api/mcp", e);
  }
}
