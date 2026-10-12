#!/usr/bin/env node
// LogMem MCP over stdio.
//
// Env:
//   LOGMEM_SPACE            space for this connection (default: madez)
//   LOGMEM_SPACES           comma list of spaces allowed (default: LOGMEM_SPACE)
//   LOGMEM_AGENT            agent for the auto Start if none is chosen
//   LOGMEM_SURFACE          surface name for "agent (via surface)" (default: MCP client name)
//   LOGMEM_ACMI_COMPAT=1    also expose acmi_* tools and read acmi:* keys
//   LOGMEM_REDIS_URI / LOGMEM_REST_URL + LOGMEM_REST_TOKEN   backend (see lib/backend.mjs)
//   LOGMEM_REQUIRE_BACKEND=1  exit 1 instead of starting in degraded (in-memory) mode
//   LOGMEM_REDIS_TIMEOUT_MS   per-command Redis timeout (default 5000)
//
// Degraded mode: if the backend is unreachable at startup (and
// LOGMEM_REQUIRE_BACKEND is not set) this process runs on an in-memory store,
// re-probes the real backend every 60 s and switches over when it answers.
// DATA-LOSS RISK: writes made while degraded stay in this process only; they
// are not replayed to the real backend and are gone when the process exits.
// Every tool result carries degraded:true while this is the case.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogmem, compatFromEnv, mirrorConfigFromEnv, SERVER_INFO, INSTRUCTIONS } from "../server.mjs";
import { resilientBackendFromEnv, BackendRequiredError } from "../lib/backend.mjs";

const log = (m) => console.error(`[logmem] ${m}`);
const env = process.env;
const space = env.LOGMEM_SPACE || env.ACMI_DEFAULT_TENANT || "madez";
const spaces = (env.LOGMEM_SPACES || space).split(",").map((s) => s.trim()).filter(Boolean);
let backend;
try {
  backend = await resilientBackendFromEnv(env, log);
} catch (e) {
  if (e instanceof BackendRequiredError) {
    console.error(`[logmem] fatal: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

// Surface is known only after initialize; tools are registered now, so the
// LogMem instance is built lazily on the first call.
let lm = null;
const sessionId = `stdio-${randomUUID()}`;
function instance() {
  if (lm) return lm;
  const client = mcp.server.getClientVersion?.();
  lm = createLogmem({
    redis: backend.redis,
    backend: () => backend.kind,
    isDegraded: backend.degraded,
    space,
    spaces,
    compat: compatFromEnv(env),
    surface: env.LOGMEM_SURFACE || client?.name || "stdio",
    sessionId,
    defaultAgent: env.LOGMEM_AGENT,
    mirror: mirrorConfigFromEnv(env),
  });
  return lm;
}

// Register with a throwaway instance for the tool list, delegate calls to the real one.
const shape = createLogmem({ redis: backend.redis, space, spaces, compat: compatFromEnv(env), sessionId });
for (const t of shape.tools) {
  mcp.registerTool(
    t.name,
    { title: t.title, description: t.description, inputSchema: t.params.shape, annotations: t.annotations },
    (args) => instance().callTool(t.name, args),
  );
}

// Idle sweep: write the 30-min auto Recap even if no further call arrives.
setInterval(() => {
  if (lm) lm.shifts.sweep().catch((e) => log(`sweep failed: ${e.message}`));
}, 60_000).unref();

await mcp.connect(new StdioServerTransport());
log(`ready: version=${SERVER_INFO.version} space=${space} backend=${backend.kind} compat=${compatFromEnv(env)} mirror=${JSON.stringify(mirrorConfigFromEnv(env))}`);
