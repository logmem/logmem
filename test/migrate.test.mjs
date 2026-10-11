import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { dryRun, planKey, readOnly } from "../scripts/migrate-dry-run.mjs";

test("planKey maps ACMI slots and namespaces; flags the rest", () => {
  assert.equal(planKey("acmi:madez:thread:agent-coordination:timeline", "madez").target, "lm:madez:channel:agent-coordination:log");
  assert.equal(planKey("acmi:madez:agent:quill:rollup:latest", "madez").target, "lm:madez:agent:quill:recap");
  assert.equal(planKey("acmi:madez:work:list", "madez").target, "lm:madez:job:list");
  assert.equal(planKey("acmi:madez:bus:relay:events:x:timeline", "madez").unmapped, "id-has-colon");
  assert.equal(planKey("acmi:madez:user:_convention:hitl", "madez").unmapped, "unknown-slot");
});

test("guard: dry run cannot write", async () => {
  const r = readOnly(createMemoryRedis());
  await assert.rejects(r("SET", "k", "v"), /not a read command/);
  await assert.rejects(r("ZADD", "k", 1, "m"), /not a read command/);
});

test("dryRun counts rescoring, kind remaps and unmapped keys, and writes nothing", async () => {
  const redis = createMemoryRedis();
  const tl = "acmi:madez:thread:c:timeline";
  await redis("ZADD", tl, 1791700000000 * 1e6, JSON.stringify({ ts: 1791700000000 * 1e6, source: "a", kind: "task-delegation", correlationId: "x", summary: "ns" }));
  await redis("ZADD", tl, 1791700001000, JSON.stringify({ ts: 1791700001000, source: "b", kind: "weird-kind", correlationId: "y", summary: "ms" }));
  await redis("SET", "acmi:madez:agent:q:signals", JSON.stringify({ a: 1, b: 2 }));
  await redis("SET", "acmi:madez:work:w:timeline", "[]");
  await redis("SET", "acmi:madez:user:_convention:hitl", "x");
  const before = JSON.stringify([...redis._data.entries()].map(([k, v]) => [k, v.type]));
  const rep = await dryRun(redis, "madez");
  assert.equal(JSON.stringify([...redis._data.entries()].map(([k, v]) => [k, v.type])), before);
  assert.equal(rep.writes, 0);
  assert.equal(rep.entries.total, 2);
  assert.equal(rep.entries.rescored, 1);
  assert.equal(rep.score_units.ns, 1);
  assert.equal(rep.entries.kinds_remapped, 1);
  assert.equal(rep.entries.kinds_alias_preserved, 1);
  assert.equal(rep.kinds_unknown_top[0][0], "weird-kind");
  assert.equal(rep.now_fields, 2);
  assert.equal(rep.timeline_as_string[0].key, "acmi:madez:work:w:timeline");
  assert.equal(rep.unmapped["unknown-slot"], 1);
});
