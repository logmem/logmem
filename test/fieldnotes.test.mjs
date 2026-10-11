import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { runDay } from "../scripts/fieldnotes-day.mjs";
import { runCheck } from "../scripts/dogfood-check.mjs";

test("Field Notes day: every step ok, job log in order, check passes", async () => {
  const redis = createMemoryRedis();
  const r = await runDay(redis);
  assert.equal(r.ok, true, JSON.stringify(r.kinds));
  const { day } = await runCheck(redis, { space: "fieldnotes", mirrorSpaces: [] });
  assert.equal(day.agents.length, 4);
  assert.equal(day.handoffs, 1);
  assert.equal(day.accepted, 1);
  assert.equal(day.pass, true);
});

test("Field Notes day with the mirror on: zero mismatches", async () => {
  const redis = createMemoryRedis();
  const r = await runDay(redis, { space: "madez", mirror: { enabled: true, spaces: ["madez"] } });
  assert.equal(r.ok, true);
  const { day } = await runCheck(redis, { space: "madez" });
  assert.equal(day.mirror_mismatches, 0);
  assert.equal(day.pass, true);
});
