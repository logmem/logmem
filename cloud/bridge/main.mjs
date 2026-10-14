#!/usr/bin/env node
// acmi-bridge entry point: read env, build the Redis runner, self-test, listen.
//
// Env (config from env only; the bridge token itself is never in env):
//   ACMI_TENANT               tenant id, e.g. acme (keys: acmi:t-acme:*, lm:t-acme:*)
//   ACMI_BRIDGE_TOKEN_SHA256  hex sha256 of the bridge token
//   ACMI_REDIS_URL            redis://acmi-t-{tenant}:pw@redis:6379 (native RESP, per-tenant ACL user),
//                             rediss://..., or http(s)://... (an upstream Redis REST endpoint)
//   ACMI_REDIS_TOKEN          bearer for an http(s) upstream only
//   ACMI_METER_REDIS_URL      redis://acmi-meter:pw@redis:6379, the meter's OWN connection and ACL user
//                             (only ~acmi:cloud:meter:*). Required with a meter and a redis:// upstream.
//   ACMI_METER_REDIS_TOKEN    bearer when ACMI_METER_REDIS_URL is http(s)
//   ACMI_BRIDGE_PORT          listen port (default 8080)
//   ACMI_BRIDGE_HOST          listen address (default 0.0.0.0)
//   ACMI_PLAN_QUOTAS          plan for quota checks: a plan id from cloud/plans.json, or a JSON plan
//   ACMI_METER_MODULE         path to the meter module (default ../meter/index.mjs)
//   ACMI_BRIDGE_RATE_CAPACITY / ACMI_BRIDGE_RATE_PER_SEC   token bucket (per key)
//   ACMI_BRIDGE_MAX_CONNECTIONS / ACMI_BRIDGE_MAX_IN_FLIGHT
//
// Nothing secret is ever logged: not the token hash, not the Redis URL.
// Zero runtime dependencies: the native path is cloud/bridge/resp.mjs.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBridge, validateLimits, DEFAULT_LIMITS, tenantPrefixes, utcMonth, VERSION } from "./bridge.mjs";
import { createRespRunner } from "./resp.mjs";

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ level: "fatal", msg })}\n`);
  process.exit(1);
}

function warn(msg) {
  process.stdout.write(`${JSON.stringify({ level: "warn", msg })}\n`);
}

function info(msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", msg, ...extra })}\n`);
}

async function runnerFor(url, token, name, { commandTimeoutMs, maxReplyBytes }) {
  if (/^rediss?:\/\//i.test(url)) {
    try {
      return createRespRunner(url, { timeoutMs: commandTimeoutMs, maxReplyBytes });
    } catch (e) {
      // e.g. a user with no password: never fall back to Redis's default user
      throw new Error(`${name}: ${String(e?.message || "invalid url").replace(/^invalid redis url:? ?/, "invalid redis url ").trim()}`);
    }
  }
  if (/^https?:\/\//i.test(url)) {
    if (!token) throw new Error(`${name.replace("_URL", "_TOKEN")} is required for an http(s) ${name}`);
    const { createRedis } = await import("../../src/lib/redis-rest.mjs");
    return createRedis({ url, token });
  }
  throw new Error(`${name} must be redis://, rediss://, http:// or https://`);
}

/** Build the canonical Redis runner (tenant commands) from ACMI_REDIS_URL. */
export async function redisFromEnv(env = process.env, { commandTimeoutMs = DEFAULT_LIMITS.commandTimeoutMs, maxReplyBytes } = {}) {
  return runnerFor(env.ACMI_REDIS_URL || "", env.ACMI_REDIS_TOKEN, "ACMI_REDIS_URL", { commandTimeoutMs, maxReplyBytes });
}

/**
 * The meter's own runner (A1): a separate connection as a separate ACL user
 * that can touch only acmi:cloud:meter:*, so the tenant's user needs no meter
 * access and no EVALSHA. Required when the tenant upstream is redis://.
 * A REST upstream without ACMI_METER_REDIS_URL shares the REST runner (no ACL
 * split is possible there).
 */
export async function meterRedisFromEnv(env = process.env, tenantRedis, { commandTimeoutMs = DEFAULT_LIMITS.commandTimeoutMs } = {}) {
  const url = env.ACMI_METER_REDIS_URL || "";
  if (!url) {
    if (tenantRedis?.kind === "resp") throw new Error("ACMI_METER_REDIS_URL is required with a meter and a redis:// ACMI_REDIS_URL");
    return tenantRedis;
  }
  if (url === env.ACMI_REDIS_URL) throw new Error("ACMI_METER_REDIS_URL must be a different Redis user than ACMI_REDIS_URL");
  const r = await runnerFor(url, env.ACMI_METER_REDIS_TOKEN, "ACMI_METER_REDIS_URL", { commandTimeoutMs });
  return r.kind === "resp" ? meterRunner(r) : r;
}

const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");

/**
 * The runner the meter uses on a native upstream. EVAL is sent as EVALSHA
 * first, so the per-tenant ACL user needs only +evalsha once the provisioner
 * has loaded the reserve script (acl.template.txt). On NOSCRIPT it falls back
 * to EVAL, which the ACL may deny; that error then fails the write closed.
 */
export function meterRunner(redis) {
  const run = async (...cmd) => {
    if (String(cmd[0]).toUpperCase() !== "EVAL") return redis(...cmd);
    const [, script, ...rest] = cmd;
    try {
      return await redis("EVALSHA", sha1(script), ...rest);
    } catch (e) {
      if (!/^NOSCRIPT/.test(String(e?.message))) throw e;
      return redis("EVAL", script, ...rest);
    }
  };
  run.close = redis.close;
  return run;
}

/** Load the meter module if present. Accepts named exports or a default object. */
export async function meterFromEnv(env = process.env) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = env.ACMI_METER_MODULE ? [env.ACMI_METER_MODULE] : [`${here}../meter/index.mjs`];
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const m = mod.default && typeof mod.default.meter === "function" ? mod.default : mod;
      if (typeof m.meter === "function" && typeof m.checkQuota === "function") {
        return {
          meter: m.meter,
          checkQuota: m.checkQuota,
          ...(typeof m.refund === "function" ? { refund: m.refund } : {}),
          reserveScript: typeof m.RESERVE_LUA === "string" ? m.RESERVE_LUA : null,
          ttlSeconds: Number.isFinite(m.METER_TTL_SECONDS) ? m.METER_TTL_SECONDS : 400 * 86400,
        };
      }
    } catch (e) {
      if (env.ACMI_METER_MODULE || e?.code !== "ERR_MODULE_NOT_FOUND") throw new Error("meter module failed to load");
    }
  }
  return null;
}

/**
 * ACMI_PLAN_QUOTAS is either a plan object (JSON) or a plan name looked up in
 * cloud/plans.json (aliases honoured; the file's grace_ratio is the default).
 */
export function planFromEnv(env = process.env, plansPath = fileURLToPath(new URL("../plans.json", import.meta.url))) {
  const raw = (env.ACMI_PLAN_QUOTAS || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("ACMI_PLAN_QUOTAS is not valid JSON");
    }
  }
  let file;
  try {
    file = JSON.parse(readFileSync(plansPath, "utf8"));
  } catch {
    throw new Error("ACMI_PLAN_QUOTAS names a plan but cloud/plans.json is unreadable");
  }
  const name = file.aliases?.[raw] && typeof file.aliases[raw] === "string" ? file.aliases[raw] : raw;
  const plan = Object.hasOwn(file.plans || {}, name) ? file.plans[name] : null;
  if (!plan) throw new Error("ACMI_PLAN_QUOTAS names an unknown plan");
  return { grace_ratio: file.grace_ratio, ...plan, id: name };
}

const refusingPlan = (plan) =>
  plan && typeof plan === "object" && plan.limits?.add !== null && plan.limits?.add !== undefined && !(plan.overage && plan.overage.billed === true);

/**
 * Startup self-test against the real upstream. Throws (generic message) when
 * the bridge could not serve or meter correctly, so it refuses to start
 * instead of failing open:
 *   1. PING
 *   2. INCRBY/EXPIRE/DEL on an acmi:t-{tenant}: scratch key (tenant ACL)
 *   3. with a meter: INCRBY 0 + EXPIRE on the meter's own month counter
 *      (the commands meter() and refunds use, on the meter's key tree)
 *   4. with a refusing plan: the reserve script as a no-op (n=0, cap -1 never
 *      reserves), through the EVALSHA-first runner
 *   5. with a plan: checkQuota for a read (validates the plan, no counting)
 */
export async function selfTest({ redis, meterRedis = redis, meter, plan, tenant, now = Date.now() }) {
  const step = async (name, fn) => {
    try {
      await fn();
    } catch {
      throw new Error(`self-test failed: ${name}`);
    }
  };
  await step("ping", async () => {
    if ((await redis("PING")) !== "PONG") throw new Error();
  });
  const scratch = `${tenantPrefixes(tenant)[0]}bridge:selftest`;
  await step("tenant write", async () => {
    if (Number(await redis("INCRBY", scratch, 1)) < 1) throw new Error();
    await redis("EXPIRE", scratch, 60);
    await redis("DEL", scratch);
  });
  if (!meter) return { metered: false };
  const ttl = String(meter.ttlSeconds ?? 400 * 86400);
  const total = `acmi:cloud:meter:${tenant}:${utcMonth(now)}:ops_total`;
  await step("meter counter", async () => {
    if (!Number.isFinite(Number(await meterRedis("INCRBY", total, 0)))) throw new Error();
    await meterRedis("EXPIRE", total, ttl);
  });
  if (refusingPlan(plan) && meter.reserveScript) {
    await step("meter reserve", async () => {
      // n = 1 against a cap of -1: the script refuses before it increments, so
      // this proves the script runs (EVALSHA) without changing any counter.
      const add = `acmi:cloud:meter:${tenant}:${utcMonth(now)}:add`;
      const r = await meterRedis("EVAL", meter.reserveScript, 2, add, total, "1", "0", "-1", ttl);
      if (!Array.isArray(r) || Number(r[0]) !== 0) throw new Error();
    });
  }
  // A1: with a separate meter connection, the tenant's Redis user should not
  // reach the meter's keys. Not fatal (a dev Redis has no ACLs), but loud.
  if (meterRedis !== redis) {
    let reachable = false;
    try {
      await redis("TTL", total);
      reachable = true;
    } catch {
      /* NOPERM expected */
    }
    if (reachable) warn("tenant Redis user can reach meter keys: apply cloud/bridge/acl.template.txt");
  }
  if (plan !== null) {
    await step("quota check", async () => {
      const q = await meter.checkQuota(meterRedis, tenant, "read", plan, { n: 1, now });
      if (q?.ok !== true) throw new Error();
    });
  }
  return { metered: true };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function limitsFromEnv(env = process.env) {
  const limits = {};
  const map = {
    ACMI_BRIDGE_RATE_CAPACITY: "rateCapacity",
    ACMI_BRIDGE_RATE_PER_SEC: "rateRefillPerSec",
    ACMI_BRIDGE_MAX_IN_FLIGHT: "maxInFlight",
  };
  for (const [k, v] of Object.entries(map)) {
    if (env[k] === undefined || env[k] === "") continue;
    const n = num(env[k]);
    if (n === null) throw new Error(`${k} must be a positive number`);
    limits[v] = n;
  }
  validateLimits({ ...DEFAULT_LIMITS, ...limits });
  return limits;
}

export async function start(env = process.env) {
  const tenant = env.ACMI_TENANT;
  const tokenSha256 = env.ACMI_BRIDGE_TOKEN_SHA256;
  const port = num(env.ACMI_BRIDGE_PORT) ?? 8080;
  const host = env.ACMI_BRIDGE_HOST || "0.0.0.0";
  const limits = limitsFromEnv(env);
  const redis = await redisFromEnv(env);
  const meter = await meterFromEnv(env);
  const plan = planFromEnv(env);
  // Quotas configured but no meter to enforce them: refuse to start rather
  // than silently run unmetered.
  if (plan !== null && !meter) throw new Error("ACMI_PLAN_QUOTAS is set but no meter module is available");
  const meterRedis = meter ? await meterRedisFromEnv(env, redis) : redis;
  await selfTest({ redis, meterRedis, meter, plan, tenant });

  // The meter gets the EVALSHA-first runner; tenant commands never reach it.
  const boundMeter = meter && {
    meter: (_r, ...a) => meter.meter(meterRedis, ...a),
    checkQuota: (_r, ...a) => meter.checkQuota(meterRedis, ...a),
    ...(meter.refund ? { refund: (_r, ...a) => meter.refund(meterRedis, ...a) } : {}),
  };
  const bridge = createBridge({ tenant, tokenSha256, redis, meter: boundMeter, plan, limits });
  const server = createServer(bridge.handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxConnections = num(env.ACMI_BRIDGE_MAX_CONNECTIONS) ?? 256;
  await new Promise((resolve) => server.listen(port, host, resolve));
  info("acmi-bridge listening", { tenant, port, version: VERSION, metered: Boolean(meter) });

  const stop = () => {
    server.close(() => Promise.allSettled([bridge.close(), meterRedis !== redis && meterRedis?.close?.()]).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { server, bridge };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  start().catch((e) => fail(String(e?.message || "startup failed").slice(0, 200)));
}
