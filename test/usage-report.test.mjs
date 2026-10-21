// The read-only weekly usage report (plans-metering).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { usageReport } from "../scripts/usage-report.mjs";

test("usage report: counts entries, writers and a month estimate, read only", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "claude-code", defaultAgent: "quill" });
  await lm.callTool("logmem_note", { where: "channel:ideas", summary: "one" });
  await lm.callTool("logmem_assign", { job: "j1", title: "Job one" });
  const before = JSON.stringify(await redis("KEYS", "*"));
  const calls = [];
  const spy = async (...c) => { calls.push(c[0]); return redis(...c); };
  const r = await usageReport(spy, { space: "madez", days: 7 });
  assert.ok(r.entries >= 3, "started, the note and the assigned entry");
  assert.equal(r.agents, 1);
  assert.equal(r.month_estimate, Math.round((r.entries * 30) / 7));
  assert.deepEqual([...new Set(calls)].sort(), ["SMEMBERS", "ZRANGEBYSCORE"], "read-only commands only");
  assert.equal(JSON.stringify(await redis("KEYS", "*")), before, "nothing written");
});

test("usage report: entries outside the window are not counted", async () => {
  const redis = createMemoryRedis();
  await redis("SADD", "lm:s:channel:list", "c");
  await redis("ZADD", "lm:s:channel:c:log", "1000", JSON.stringify({ ts: 1000, by: "agent:a", kind: "memo" }));
  const now = 30 * 86400000;
  await redis("ZADD", "lm:s:channel:c:log", String(now - 1000), JSON.stringify({ ts: now - 1000, by: "agent:a", kind: "memo" }));
  const r = await usageReport(redis, { space: "s", days: 7, now });
  assert.equal(r.entries, 1);
});

test("usage report: ISO timestamps and bad rows never abort it (codex review of PR 93)", async () => {
  const redis = createMemoryRedis();
  const now = Date.parse("2026-10-21T12:00:00Z");
  await redis("SADD", "lm:s:job:list", "j");
  const key = "lm:s:job:j:log";
  await redis("ZADD", key, String(now - 1000), JSON.stringify({ ts: new Date(now - 1000).toISOString(), by: "agent:a", kind: "memo" }));
  await redis("ZADD", key, String(now - 2000), "not json");
  await redis("ZADD", key, String(now - 3000), JSON.stringify({ ts: "garbage", by: "agent:b", kind: "memo" }));
  await redis("ZADD", key, String(now - 4000), JSON.stringify({ ts: now - 4000, by: "human:mikey", kind: "memo" }));
  const r = await usageReport(redis, { space: "s", days: 7, now });
  assert.equal(r.entries, 4);
  assert.equal(r.unreadable, 2);
  assert.equal(r.by_day["2026-10-21"], 2);
  assert.equal(r.agents, 2);
  assert.equal(r.people, 1);
});
