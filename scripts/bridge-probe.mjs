#!/usr/bin/env node
// bridge-probe.mjs — prove the Redis backend accepts every command LogMem uses.
//
// Works only on lm:probe:<ts>:* keys and deletes them at the end (also on
// failure). Exit 0 = all commands accepted; exit 1 = list of refusals.
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/bridge-probe.mjs
//   LOGMEM_REDIS_URI=redis://127.0.0.1:6399 node scripts/bridge-probe.mjs

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

export async function probe(redis) {
  const p = `lm:probe:${Date.now()}`;
  const s = `${p}:set`, h = `${p}:hash`, z = `${p}:zset`, str = `${p}:str`, lock = `${p}:lock`;
  const steps = [
    ["PING"],
    ["SET", str, "v"], ["GET", str], ["TYPE", str], ["EXISTS", str], ["EXPIRE", str, "60"],
    ["SET", lock, "t", "NX", "EX", "60"], // the dogfood check's run lock
    ["SADD", s, "a", "b"], ["SMEMBERS", s], ["SREM", s, "b"],
    ["HSET", h, "f", "1", "g", "2"], ["HGETALL", h], ["HDEL", h, "g"],
    ["ZADD", z, "1791700000000", "m1"], ["ZADD", z, "1791700000001", "m2"],
    ["ZRANGE", z, "0", "-1", "WITHSCORES"], ["ZREVRANGE", z, "0", "0", "WITHSCORES"],
    ["ZRANGEBYSCORE", z, "1791700000000", "+inf", "WITHSCORES"], ["ZCARD", z], ["ZREM", z, "m2"],
    ["LRANGE", `${p}:none`, "0", "-1"],
    ["SCAN", "0", "MATCH", `${p}:*`, "COUNT", "100"],
  ];
  const results = [];
  try {
    for (const cmd of steps) {
      try {
        await redis(...cmd);
        results.push({ cmd: cmd[0], ok: true });
      } catch (e) {
        results.push({ cmd: cmd[0], ok: false, error: e.message });
      }
    }
  } finally {
    try {
      await redis("DEL", str, s, h, z, lock);
      results.push({ cmd: "DEL", ok: true });
    } catch (e) {
      results.push({ cmd: "DEL", ok: false, error: e.message });
    }
  }
  const left = Number(await redis("EXISTS", z).catch(() => 0));
  return { prefix: p, ok: results.every((r) => r.ok) && !left, leftover: left, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const d = descriptorFromEnv();
  if (!d) {
    console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
    process.exit(1);
  }
  const r = await probe(fromDescriptor(d).redis);
  for (const x of r.results) console.log(`${x.ok ? "OK  " : "FAIL"} ${x.cmd}${x.ok ? "" : `  ${x.error}`}`);
  console.log(r.ok ? `\nprobe passed (${r.prefix}, cleaned)` : `\nprobe FAILED (leftover keys: ${r.leftover})`);
  process.exit(r.ok ? 0 : 1);
}
