// jail.mjs — keep one managed user inside their own space on the customer Redis.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-one-click-connect-design.md, 4.5.
// A managed user (tenant {id}) gets space t-{id}. Every command a LogMem
// connection sends for that user goes through createJail(), which allows only
// keys under lm:t-{id}: and refuses everything else. The rules are the cloud
// bridge's (checkCommand in cloud/bridge/bridge.mjs, BACKPLANE.md): one command
// table, cross-key commands check every key, SCAN gets a forced MATCH, and
// scripting, admin and KEYS commands are refused. One module serves both the
// in-process jail here and a later per-user bridge.
//
// The meter (acmi:cloud:meter:*) and the tenant registry (acmi:cloud:tenant:*)
// are reached by server code through customerRedis() directly, never through a
// user's jailed runner.

import { checkCommand } from "../../cloud/bridge/bridge.mjs";
import { namespaceFor } from "../../cloud/tenants/index.mjs";
import { insecureAllowed } from "../../api/oauth/_lib/storage.mjs";

/** A refused command. The message never names a key or a value. */
export class JailError extends Error {
  constructor(status = 403) {
    super("jail: command not allowed");
    this.name = "JailError";
    this.status = status;
  }
}

export class CustomerRedisConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CustomerRedisConfigError";
  }
}

/** The space for a tenant: "t-{id}". Throws on an invalid or reserved id. */
export function tenantSpace(tenantId) {
  return namespaceFor(tenantId);
}

/**
 * Wrap a Redis runner so it can only touch lm:t-{tenantId}:*.
 * Returns a runner with the usual shape: (cmd, ...args) => result.
 */
export function createJail(redis, tenantId, limits = {}) {
  const space = tenantSpace(tenantId);
  const prefixes = [`lm:${space}:`];
  const run = async (...cmd) => {
    const args = cmd.map((a) => (typeof a === "number" ? String(a) : a));
    const c = checkCommand(args, { ...limits, prefixes });
    if (!c.ok) throw new JailError(c.status);
    return redis(...c.cmd);
  };
  run.space = space;
  return run;
}

/** The customer Redis URI. rediss:// is required outside local dev. */
export function customerRedisUri(env = process.env) {
  const uri = String(env.LOGMEM_CUSTOMER_REDIS_URI || "").trim();
  if (!uri) throw new CustomerRedisConfigError("LOGMEM_CUSTOMER_REDIS_URI is not set");
  if (/^rediss:\/\//i.test(uri)) return uri;
  if (/^redis:\/\//i.test(uri) && insecureAllowed(env)) return uri;
  throw new CustomerRedisConfigError("LOGMEM_CUSTOMER_REDIS_URI must start with rediss:// (TLS)");
}

/** Unjailed runner for server code (meter, registry, accounts). Never hand it to a user's connection. */
export function customerRedis(env = process.env) {
  const uri = customerRedisUri(env);
  return async (...cmd) => {
    const { nativeRedisCall } = await import("../lib/redis-native.mjs");
    return nativeRedisCall(uri, ...cmd);
  };
}
