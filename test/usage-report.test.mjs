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
  assert.equal(r.entries, 2, "the note and the assigned entry; the auto Start writes none");
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

test("usage report: JSON null, non-objects and out-of-range timestamps are unreadable (codex re-review of PR 93)", async () => {
  const redis = createMemoryRedis();
  const now = Date.parse("2026-10-21T12:00:00Z");
  await redis("SADD", "lm:s:job:list", "j");
  const key = "lm:s:job:j:log";
  await redis("ZADD", key, String(now - 1000), "null");
  await redis("ZADD", key, String(now - 2000), JSON.stringify({ ts: 1e30, by: "agent:a", kind: "memo" }));
  await redis("ZADD", key, String(now - 3000), "[1,2]");
  await redis("ZADD", key, String(now - 4000), "42");
  await redis("ZADD", key, String(now - 5000), JSON.stringify({ ts: -5, by: "agent:b", kind: "memo" }));
  await redis("ZADD", key, String(now - 6000), JSON.stringify({ ts: now - 6000, by: "agent:c", kind: "memo" }));
  const r = await usageReport(redis, { space: "s", days: 7, now });
  assert.equal(r.entries, 6);
  assert.equal(r.unreadable, 5);
  assert.equal(r.by_day["2026-10-21"], 1);
  assert.equal(r.agents, 3, "a row with a bad ts still names its writer");
});
