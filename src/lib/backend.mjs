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

/** Resolve and verify with PING; fall back to memory so stdio never hard-exits. */
export async function backendFromEnv(env = process.env, log = () => {}) {
  const d = descriptorFromEnv(env);
  const b = d && fromDescriptor(d);
  if (b) {
    try {
      await b.redis("PING");
      return b;
    } catch (e) {
      log(`backend ${b.kind} unreachable (${e.message}); using in-memory (degraded)`);
    }
  } else {
    log("no backend configured; using in-memory (degraded)");
  }
  return { kind: "memory", redis: createMemoryRedis() };
}
