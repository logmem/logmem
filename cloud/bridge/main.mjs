#!/usr/bin/env node
// acmi-bridge entry point: read env, build the Redis runner, listen.
//
// Env (config from env only; the bridge token itself is never in env):
//   ACMI_TENANT               tenant id, e.g. acme
//   ACMI_BRIDGE_TOKEN_SHA256  hex sha256 of the bridge token
//   ACMI_REDIS_URL            redis://... or rediss://... (native TCP), or
//                             http(s)://... (an upstream Redis REST endpoint)
//   ACMI_REDIS_TOKEN          bearer for an http(s) upstream only
//   ACMI_BRIDGE_PORT          listen port (default 8080)
//   ACMI_BRIDGE_HOST          listen address (default 0.0.0.0)
//   ACMI_PLAN_QUOTAS          plan for quota checks: JSON object or a plan name
//   ACMI_METER_MODULE         path to the meter module (default ../meter/index.mjs)
//   ACMI_BRIDGE_RATE_CAPACITY / ACMI_BRIDGE_RATE_PER_SEC   token bucket
//
// Nothing secret is ever logged: not the token hash, not the Redis URL.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBridge, VERSION } from "./bridge.mjs";

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ level: "fatal", msg })}\n`);
  process.exit(1);
}

function info(msg, extra = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", msg, ...extra })}\n`);
}

/** Build the canonical Redis runner from ACMI_REDIS_URL. */
export async function redisFromEnv(env = process.env) {
  const url = env.ACMI_REDIS_URL || "";
  if (/^rediss?:\/\//i.test(url)) {
    const { nativeRedisCall } = await import("../../src/lib/redis-native.mjs");
    return (...cmd) => nativeRedisCall(url, ...cmd);
  }
  if (/^https?:\/\//i.test(url)) {
    if (!env.ACMI_REDIS_TOKEN) throw new Error("ACMI_REDIS_TOKEN is required for an http(s) ACMI_REDIS_URL");
    const { createRedis } = await import("../../src/lib/redis-rest.mjs");
    return createRedis({ url, token: env.ACMI_REDIS_TOKEN });
  }
  throw new Error("ACMI_REDIS_URL must be redis://, rediss://, http:// or https://");
}

/** Load the meter module if present. Accepts named exports or a default object. */
export async function meterFromEnv(env = process.env) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = env.ACMI_METER_MODULE
    ? [env.ACMI_METER_MODULE]
    : [`${here}../meter/index.mjs`, `${here}../meter/meter.mjs`];
  for (const p of candidates) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const m = mod.default && typeof mod.default.meter === "function" ? mod.default : mod;
      if (typeof m.meter === "function" && typeof m.checkQuota === "function") {
        return { meter: m.meter, checkQuota: m.checkQuota };
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

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function start(env = process.env) {
  const tenant = env.ACMI_TENANT;
  const tokenSha256 = env.ACMI_BRIDGE_TOKEN_SHA256;
  const port = num(env.ACMI_BRIDGE_PORT, 8080);
  const host = env.ACMI_BRIDGE_HOST || "0.0.0.0";
  const redis = await redisFromEnv(env);
  const meter = await meterFromEnv(env);
  const plan = planFromEnv(env);
  // Quotas configured but no meter to enforce them: refuse to start rather
  // than silently run unmetered.
  if (plan !== null && !meter) throw new Error("ACMI_PLAN_QUOTAS is set but no meter module is available");
  const limits = {};
  const cap = num(env.ACMI_BRIDGE_RATE_CAPACITY, null);
  const rps = num(env.ACMI_BRIDGE_RATE_PER_SEC, null);
  if (cap) limits.rateCapacity = cap;
  if (rps) limits.rateRefillPerSec = rps;

  const bridge = createBridge({ tenant, tokenSha256, redis, meter, plan, limits });
  const server = createServer(bridge.handler);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  await new Promise((resolve) => server.listen(port, host, resolve));
  info("acmi-bridge listening", { tenant, port, version: VERSION, metered: Boolean(meter) });

  const stop = () => {
    server.close(() => bridge.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return { server, bridge };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  start().catch((e) => fail(e?.message || "startup failed"));
}
