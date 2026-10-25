// backend.mjs — pick a Redis runner from env (stdio) or a descriptor (HTTP).
//
// Priority (stdio):
//   1. LOGMEM_REDIS_URI (or ACMI_REDIS_URI)              -> native TCP Redis
//   2. LOGMEM_REST_URL + LOGMEM_REST_TOKEN               -> HTTP Redis REST
//      (ACMI_BRIDGE_URL/_TOKEN and UPSTASH_REDIS_REST_URL/_TOKEN accepted)
//   3. nothing reachable                                 -> in-memory (degraded)

import { createRedis } from "./redis-rest.mjs";
import { createMemoryRedis } from "./memory-redis.mjs";

export function fromDescriptor(d) {
  // Local dev only (scripts/dev-site.mjs --seed): an in-process Redis.
  if (String(d?.url || "").startsWith("memory://") && globalThis.__lmDevRedis) return { kind: "memory", redis: globalThis.__lmDevRedis };
  if (d?.kind === "redis" && d.uri) {
    return {
      kind: "native",
      redis: async (...cmd) => {
        const { nativeRedisCall } = await import("./redis-native.mjs");
        return nativeRedisCall(d.uri, ...cmd);
      },
    };
  }
  if (d?.url && d?.token) return { kind: "rest", redis: createRedis({ url: d.url, token: d.token }) };
  return null;
}

export function descriptorFromEnv(env = process.env) {
  const uri = env.LOGMEM_REDIS_URI || env.ACMI_REDIS_URI;
  if (uri) return { kind: "redis", uri };
  const url = env.LOGMEM_REST_URL || env.ACMI_BRIDGE_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.LOGMEM_REST_TOKEN || env.ACMI_BRIDGE_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  return null;
}

// ---- stdio degraded mode ----------------------------------------------------
//
// When the configured backend is unreachable at startup, stdio falls back to an
// in-memory store so the MCP client still gets a working tool list. That is a
// data-loss risk: anything written while degraded lives only in this process
// and is NOT replayed to the real backend when it comes back (or when the
// process exits). Three mitigations:
//
//   LOGMEM_REQUIRE_BACKEND=1  refuse to start without a reachable backend
//                             (BackendRequiredError; stdio exits 1).
//   re-probe                  every 60 s, PING the configured backend and
//                             switch to it as soon as it answers.
//   degraded:true             every tool result carries it while in memory
//                             mode, so agents can tell their writes are
//                             not durable (see createLogmem({ isDegraded })).

export const REPROBE_MS = 60_000;

export class BackendRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackendRequiredError";
  }
}

export const requireBackendFromEnv = (env = process.env) =>
  ["1", "true", "yes"].includes(String(env.LOGMEM_REQUIRE_BACKEND || "").toLowerCase());

/**
 * Backend for long-lived stdio processes.
 *
 *   { current(), redis, kind (getter), degraded(), probeNow(), stop() }
 *
 * current() returns the active { kind, redis } pair. Callers that run several
 * commands as one unit (createLogmem's callTool) must take ONE snapshot of
 * current() and use it for the whole unit, so a single tool call never mixes
 * the in-memory store and the real backend. `redis` delegates per command and
 * is only for one-off calls.
 */
export async function resilientBackendFromEnv(env = process.env, log = () => {}, {
  reprobeMs = REPROBE_MS,
  resolve = (e) => { const d = descriptorFromEnv(e); return d && fromDescriptor(d); },
} = {}) {
  const required = requireBackendFromEnv(env);
  let configured = null;
  let reason = "no backend configured";
  try {
    configured = resolve(env) || null;
  } catch (e) {
    // A malformed URI/URL must degrade, not crash the stdio process.
    reason = `backend config invalid (${e.message})`;
  }
  let current = null;
  if (configured) {
    try {
      await configured.redis("PING");
      current = configured;
    } catch (e) {
      reason = `backend ${configured.kind} unreachable (${e.message})`;
    }
  }
  if (!current && required) {
    throw new BackendRequiredError(`${reason}; LOGMEM_REQUIRE_BACKEND=1 so refusing to start in degraded (in-memory) mode`);
  }

  let timer = null;
  if (!current) {
    log(`${reason}; using in-memory (degraded). Writes are NOT durable and are not replayed when the backend returns.`);
    current = { kind: "memory", redis: createMemoryRedis() };
  }

  let probing = null;
  function probeNow() {
    if (!configured || current === configured) return Promise.resolve(current.kind !== "memory");
    if (probing) return probing; // one PING in flight at a time
    probing = (async () => {
      try {
        await configured.redis("PING");
      } catch {
        return false;
      }
      current = configured;
      if (timer) clearInterval(timer);
      timer = null;
      log(`backend ${configured.kind} reachable again; switched over from in-memory. Writes made while degraded were not copied.`);
      return true;
    })().finally(() => { probing = null; });
    return probing;
  }

  if (current.kind === "memory" && configured && reprobeMs > 0) {
    timer = setInterval(() => { probeNow().catch(() => {}); }, reprobeMs);
    timer.unref?.();
  }

  return {
    current: () => current,
    redis: (...cmd) => current.redis(...cmd),
    get kind() { return current.kind; },
    degraded: () => current.kind === "memory",
    probeNow,
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
