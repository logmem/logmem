// api/mcp.mjs — Streamable HTTP MCP server with JSON-RPC fallback.
//
// URL: https://acmi-product.vercel.app/api/mcp
// Listed at: https://smithery.ai/servers/madezmediapartners/acmi-mcp
//
// Two transport paths:
//   1. SSE-capable clients (Smithery proxy, sophisticated MCP clients) get the
//      SDK's StreamableHTTPServerTransport returning event-stream framed
//      JSON-RPC responses.
//   2. JSON-only clients (Claude Web's "add MCP integration" form, simple
//      curl probes) get a hand-rolled JSON-RPC dispatcher returning plain
//      application/json.
//
// Credential resolution (dual-backend: Upstash REST or self-hosted Redis):
//   - Smithery: ?config=<base64> with upstashRedisRestUrl + upstashRedisRestToken,
//     or redisUri for a self-hosted redis://... backend
//   - Headers: x-upstash-url/x-upstash-token, or x-redis-uri
//   - OAuth 2.1: consent form binds either backend to the access token
//   - Break-glass: MCP_DIRECT_AUTH_TOKEN bearer + server env (ACMI_REDIS_URI
//     preferred, else UPSTASH_REDIS_REST_URL/_TOKEN)
//
// Runtime: Node.js (the SDK needs Node http types).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRedis } from "./_lib/redis.mjs";
import { nativeRedisCall } from "./_lib/redis-native.mjs";
import { registerAcmiTools } from "./_lib/mcp-tools.mjs";
import { TOOL_DEFS, CONFIG_SCHEMA } from "./_lib/mcp-tool-defs.mjs";
import { lookupAccessToken } from "./oauth/_lib/storage.mjs";

export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

const SERVER_INFO = { name: "acmi", version: "1.5.0" };
const PROTOCOL_VERSION = "2024-11-05";

function decodeSmitheryConfig(req) {
  const url = new URL(req.url || "/api/mcp", "https://acmi-product.vercel.app");
  const cfgB64 = url.searchParams.get("config");
  if (!cfgB64) return {};
  try {
    const json = Buffer.from(cfgB64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (e) {
    throw new Error(`invalid base64 config: ${e.message}`);
  }
}

async function extractCreds(cfg, req) {
  // Every branch returns a backend descriptor consumable by createRedis():
  //   {url, token, ...}          — Upstash REST
  //   {kind:'redis', uri, ...}   — self-hosted Redis over TCP

  // Priority 1a: x-from headers (Smithery gateway forwarding per configSchema
  // x-from declarations in mcp-tool-defs.mjs). This is the multi-user
  // one-URL path — Smithery's hosted form collects per-user creds and
  // injects them as headers when proxying to us.
  const headerRedisUri = req.headers["x-redis-uri"] || null;
  if (headerRedisUri) {
    return { kind: "redis", uri: headerRedisUri, source: "header" };
  }
  const headerBridgeUrl = req.headers["x-acmi-bridge-url"] || null;
  const headerBridgeToken = req.headers["x-acmi-bridge-token"] || null;
  if (headerBridgeUrl && headerBridgeToken) {
    return { url: headerBridgeUrl, token: headerBridgeToken, source: "header-bridge" };
  }
  const headerUrl = req.headers["x-upstash-url"] || null;
  const headerToken = req.headers["x-upstash-token"] || null;
  if (headerUrl && headerToken) {
    return { url: headerUrl, token: headerToken, source: "header" };
  }

  // Priority 1b: per-request config blob via ?config=<base64> (legacy /
  // direct-with-embedded-creds path). Still works for clients that paste
  // a URL with the config query param baked in.
  const cfgRedisUri = cfg.redisUri || cfg.REDIS_URI || null;
  if (cfgRedisUri) {
    return { kind: "redis", uri: cfgRedisUri, source: "config" };
  }
  const cfgUrl =
    cfg.acmiBridgeUrl ||
    cfg.ACMI_BRIDGE_URL ||
    cfg.upstashRedisRestUrl ||
    cfg.UPSTASH_REDIS_REST_URL ||
    cfg.url ||
    null;
  const cfgToken =
    cfg.acmiBridgeToken ||
    cfg.ACMI_BRIDGE_TOKEN ||
    cfg.upstashRedisRestToken ||
    cfg.UPSTASH_REDIS_REST_TOKEN ||
    cfg.token ||
    null;
  if (cfgUrl && cfgToken) {
    return { url: cfgUrl, token: cfgToken, source: "config" };
  }

  // Priority 1c: OAuth 2.1 Bearer access token. Token store binds creds to
  // sub. MCP clients (Claude Web/Desktop) that completed /api/oauth/authorize
  // arrive here with a Bearer token issued by /api/oauth/token.
  const authHeader = String(req.headers.authorization || req.headers.Authorization || "");
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (bearer) {
    try {
      const tok = await lookupAccessToken(bearer);
      if (tok && (tok.expires_at ?? 0) > Math.floor(Date.now() / 1000)) {
        if (tok.backend?.kind === "redis" && tok.backend.uri) {
          return { kind: "redis", uri: tok.backend.uri, source: "oauth", sub: tok.sub };
        }
        if (tok.upstash_url && tok.upstash_token) {
          return { url: tok.upstash_url, token: tok.upstash_token, source: "oauth", sub: tok.sub };
        }
      }
    } catch {
      // fall through to env-bearer / anon
    }
  }

  // Priority 2: env-var fallback — ONLY behind a deploy-owner emergency
  // Bearer token (MCP_DIRECT_AUTH_TOKEN). Distinct from OAuth: this is the
  // operator break-glass path for ops-center / smoke tests when OAuth flow
  // is unavailable. If MCP_DIRECT_AUTH_TOKEN is unset, env fallback is
  // disabled entirely.
  const requiredToken = process.env.MCP_DIRECT_AUTH_TOKEN || null;
  if (requiredToken && bearer && bearer === requiredToken) {
    if (process.env.ACMI_REDIS_URI) {
      return { kind: "redis", uri: process.env.ACMI_REDIS_URI, source: "env-authed" };
    }
    if (process.env.ACMI_BRIDGE_URL && process.env.ACMI_BRIDGE_TOKEN) {
      return {
        url: process.env.ACMI_BRIDGE_URL,
        token: process.env.ACMI_BRIDGE_TOKEN,
        source: "env-authed-bridge",
      };
    }
    return {
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.ACMI_BRIDGE_URL || null,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.ACMI_BRIDGE_TOKEN || null,
      source: "env-authed",
    };
  }

  return { url: null, token: null, source: "none" };
}

// ─── Manual JSON-RPC dispatcher (for Accept: application/json clients) ──

function buildToolRegistry(redis) {
  const tools = {};
  const shim = {
    tool: (name, description, _schema, handler) => {
      tools[name] = { name, description, handler };
    },
  };
  registerAcmiTools(shim, redis);
  return tools;
}

async function dispatchJsonRpc(msg, tools) {
  const { id, method, params } = msg || {};
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === "notifications/initialized" || method === "initialized") {
      // notification — no response per JSON-RPC 2.0 spec
      return null;
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id: id ?? null, result: { tools: TOOL_DEFS } };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id: id ?? null, result: { resources: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id: id ?? null, result: { prompts: [] } };
    }
    if (method === "triggers/list") {
      return { jsonrpc: "2.0", id: id ?? null, result: { triggers: [] } };
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      const t = tools[name];
      if (!t) {
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32601, message: `Tool not found: ${name}` },
        };
      }
      const result = await t.handler(args);
      return { jsonrpc: "2.0", id: id ?? null, result };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id: id ?? null, result: {} };
    }
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32601, message: `Unknown method: ${method}` },
    };
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code: -32603, message: e.message || String(e) },
    };
  }
}

// ─── Main handler ───────────────────────────────────────────────────────

// Methods that return public metadata only — no Upstash access needed.
// Smithery's deployment proxy probes a wider set than just initialize +
// tools/list during scan; resources/list, prompts/list, triggers/list are
// also part of the discovery sweep. We don't expose any resources, prompts,
// or triggers, so these all return empty arrays — but they must succeed
// (200 + JSON-RPC result), not 401, or Smithery wraps the error into an
// authorizationUrl response and the scan flags them as auth-failures.
/** Hosted tools historically wrote unprefixed `acmi:ns:id:*`. Polar restore is madez-only. */
export function tenantizeKey(key, tenant) {
  if (typeof key !== "string" || !key.startsWith("acmi:")) return key;
  if (key.startsWith(`acmi:${tenant}:`)) return key;
  if (key.startsWith("acmi:client:")) return key;
  return key.replace(/^acmi:/, `acmi:${tenant}:`);
}

const ALL_KEY_CMDS = new Set([
  "DEL",
  "EXISTS",
  "MGET",
  "TOUCH",
  "UNLINK",
]);

const FIRST_TWO_KEY_CMDS = new Set([
  "COPY",
  "RENAME",
  "RENAMENX",
]);

const SET_MULTI_KEY_CMDS = new Set([
  "SDIFF",
  "SINTER",
  "SUNION",
]);

const SET_DEST_THEN_KEYS_CMDS = new Set([
  "SDIFFSTORE",
  "SINTERSTORE",
  "SUNIONSTORE",
]);

function tenantizeEvalArgs(args, tenant) {
  const numKeys = Number(args[1]) || 0;
  return args.map((arg, index) => {
    if (index >= 2 && index < 2 + numKeys) return tenantizeKey(arg, tenant);
    return arg;
  });
}

function tenantizeStoreWithNumKeysArgs(args, tenant) {
  const numKeys = Number(args[1]) || 0;
  return args.map((arg, index) => {
    if (index === 0) return tenantizeKey(arg, tenant);
    if (index >= 2 && index < 2 + numKeys) return tenantizeKey(arg, tenant);
    return arg;
  });
}

export function tenantizeArgs(cmd, args, tenant) {
  const c = String(cmd).toUpperCase();
  if (c === "SCAN") {
    return args.map((arg, index) => (
      index > 0 && String(args[index - 1]).toUpperCase() === "MATCH"
        ? tenantizeKey(arg, tenant)
        : arg
    ));
  }
  if (c === "KEYS" || ALL_KEY_CMDS.has(c) || SET_MULTI_KEY_CMDS.has(c)) {
    return args.map((arg) => tenantizeKey(arg, tenant));
  }
  if (FIRST_TWO_KEY_CMDS.has(c)) {
    return args.map((arg, index) => (index < 2 ? tenantizeKey(arg, tenant) : arg));
  }
  if (SET_DEST_THEN_KEYS_CMDS.has(c)) {
    return args.map((arg) => tenantizeKey(arg, tenant));
  }
  if (c === "EVAL" || c === "EVALSHA") return tenantizeEvalArgs(args, tenant);
  if (c === "ZUNIONSTORE" || c === "ZINTERSTORE") return tenantizeStoreWithNumKeysArgs(args, tenant);
  return args.map((arg, index) => (index === 0 ? tenantizeKey(arg, tenant) : arg));
}

export function withTenantPrefix(redis, tenant) {
  const t = tenant || "madez";
  const wrapped = async (cmd, ...args) => redis(cmd, ...tenantizeArgs(cmd, args, t));
  wrapped.keyFor = (key) => tenantizeKey(key, t);
  wrapped.tenant = t;
  return wrapped;
}

const PUBLIC_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "initialized",
  "tools/list",
  "resources/list",
  "prompts/list",
  "triggers/list",
  "ping",
]);

export default async function handler(req, res) {
  // CORS for browser-initiated MCP clients
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Session-Id, MCP-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    let cfg;
    try {
      cfg = decodeSmitheryConfig(req);
    } catch (e) {
      res.status(400).json({ error: e.message, where: "config decode" });
      return;
    }

    // Determine whether this request requires authenticated tenant creds.
    // GET probes + JSON-RPC metadata methods are public; tools/call (and any
    // unrecognized method) require auth.
    const method = req.body && req.body.method;
    const requiresAuth = req.method === "POST" && !PUBLIC_METHODS.has(method);

    const backend = await extractCreds(cfg, req);
    const { url, token, kind, uri, source, sub } = backend;
    const hasCreds = (kind === "redis" && uri) || (url && token);
    const tenant =
      cfg.ACMI_DEFAULT_TENANT ||
      cfg.acmiDefaultTenant ||
      process.env.ACMI_DEFAULT_TENANT ||
      "madez";
    let redis;
    if (hasCreds) {
      const raw = kind === "redis"
        ? (...cmd) => nativeRedisCall(uri, ...cmd)
        : createRedis({ url, token });
      redis = withTenantPrefix(raw, tenant);
      res.setHeader("X-MCP-Cred-Source", source);
      res.setHeader("X-MCP-Tenant", tenant);
      if (sub) res.setHeader("X-MCP-Sub", sub);
    } else if (requiresAuth) {
      // RFC 9728 — point unauthenticated clients at the protected resource
      // metadata so MCP clients (Claude Web/Desktop) can discover OAuth flow.
      const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const issuer = `${proto}://${host}`;
      res.setHeader("WWW-Authenticate", `Bearer realm="acmi-mcp", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
      res.status(401).json({
        error: "authentication required for tool execution",
        hint: "OAuth 2.1 + PKCE flow available. Discover via /.well-known/oauth-authorization-server. Or pass ?config=<base64 Polar exec or Upstash creds> (Smithery) or Bearer <MCP_DIRECT_AUTH_TOKEN> (deploy-owner break-glass).",
      });
      return;
    } else {
      // Public-method path with no creds — stub redis throws if a handler
      // accidentally tries to use it (defense in depth; should never fire
      // because PUBLIC_METHODS handlers don't touch redis).
      redis = async () => {
        throw new Error("Redis not available for unauthenticated requests");
      };
      res.setHeader("X-MCP-Cred-Source", "anon-public");
    }

    // Branch on Accept: SSE-capable clients get the SDK transport (preserves
    // server-initiated streaming for tool progress); JSON-only clients get a
    // plain JSON-RPC response.
    const acceptHdr = String(req.headers.accept || "").toLowerCase();
    const wantsSSE = acceptHdr.includes("text/event-stream");

    // Short-circuit metadata-list methods so BOTH SSE and JSON paths return
    // identical, schema-rich responses sourced from TOOL_DEFS:
    //   - tools/list returns full TOOL_DEFS (name + description + inputSchema
    //     + outputSchema + annotations). The SDK's auto-generated tools/list
    //     only emits inputSchema, so Smithery's quality scorer marked
    //     outputSchema 0/16 + annotations 0/16. Bypass the SDK to fix this.
    //   - resources/list, prompts/list, triggers/list return empty arrays.
    //     The SDK errors -32601 because we never register handlers (we have
    //     no resources/prompts) and triggers/list is a Smithery extension.
    const reqMethod = req.body && req.body.method;
    let shortCircuitResult = null;
    if (req.method === "POST") {
      if (reqMethod === "tools/list") {
        shortCircuitResult = { tools: TOOL_DEFS };
      } else if (reqMethod === "resources/list") {
        shortCircuitResult = { resources: [] };
      } else if (reqMethod === "prompts/list") {
        shortCircuitResult = { prompts: [] };
      } else if (reqMethod === "triggers/list") {
        shortCircuitResult = { triggers: [] };
      }
    }
    // tools/call must use our jsonResult (structuredContent). The SDK SSE
    // transport only serializes `content`, which Grok Bot rejects when
    // tools/list advertised outputSchema.
    if (req.method === "POST" && reqMethod === "tools/call") {
      const tools = buildToolRegistry(redis);
      const reply = await dispatchJsonRpc(req.body, tools);
      if (wantsSSE) {
        res.status(200).setHeader("Content-Type", "text/event-stream");
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      } else {
        res.status(200).setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply));
      }
      return;
    }
    if (shortCircuitResult !== null) {
      const reply = {
        jsonrpc: "2.0",
        id: (req.body && req.body.id) ?? null,
        result: shortCircuitResult,
      };
      if (wantsSSE) {
        res.status(200).setHeader("Content-Type", "text/event-stream");
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      } else {
        res.status(200).setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply));
      }
      return;
    }

    // SDK StreamableHTTPServerTransport opens a long-lived SSE stream waiting
    // for server-push events. Vercel serverless functions have a hard 60s
    // timeout — clients that open the stream via GET (Perplexity, some other
    // MCP clients) hit the timeout and see a broken pipe.
    // Restrict the SSE/SDK path to POST so GET requests fall through to the
    // 405/metadata handlers below. POST-mode Streamable HTTP works because
    // request/reply completes well under 60s.
    // Root cause: claude-cowork incident-correction 2026-05-11T21:49Z
    // (cid claudeCoworkPerplexityActualRootCause-1778536100000).
    if (wantsSSE && req.method === "POST") {
      const server = new McpServer(SERVER_INFO);
      registerAcmiTools(server, redis);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // JSON-only path
    if (req.method === "GET") {
      if (wantsSSE) {
        res.status(405).json({
          error: "GET not supported for SSE — use POST for Streamable HTTP requests",
          hint: "Server-push via SSE not available on Vercel serverless (60s function timeout).",
        });
        return;
      }
      // Smithery / health probe + MCP discovery — return server card-style
      // metadata. Clients SHOULD POST JSON-RPC; GET is metadata-only because
      // long-lived SSE streams are unsupported on this hosting tier (Vercel
      // serverless 60s timeout). Streamable HTTP POST mode works fine.
      res.status(200).json({
        ...SERVER_INFO,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        transport: "streamable-http",
        toolCount: TOOL_DEFS.length,
        configSchema: CONFIG_SCHEMA,
        notes: {
          method: "POST JSON-RPC for actual MCP traffic",
          sse: "long-lived SSE streams not supported via GET on this endpoint; use POST request/reply only",
          redis: "POST JSON command arrays to Polar HTTPS exec (no trailing slash) or Upstash REST",
        },
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed", allowed: ["GET", "POST", "OPTIONS"] });
      return;
    }

    const msg = req.body;
    const tools = buildToolRegistry(redis);
    const reply = await dispatchJsonRpc(msg, tools);
    if (reply === null) {
      res.status(202).end();
      return;
    }
    res.status(200).setHeader("Content-Type", "application/json").end(JSON.stringify(reply));
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || String(e), where: "mcp.handler" });
    }
  }
}
