import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { exportSpace } from "../src/http/space-export.mjs";
import { importSpace, parseBundle, SpaceImportError } from "../src/http/space-import.mjs";

test("v2 import: round-trips SET indexes, hashes, zsets into a customer s-<hex> namespace with receipt", async () => {
  const src = createMemoryRedis();
  await src("SADD", "lm:madez:agent:list", "quill", "atlas");
  await src("SET", "lm:madez:agent:quill:who", JSON.stringify({ name: "Quill", role: "Writer" }));
  await src("SADD", "lm:madez:plan:list", "p1");
  await src("SET", "lm:madez:plan:p1", JSON.stringify({ id: "p1", title: "Ship Portability", milestones: [{ id: "m1" }] }));
  await src("SADD", "lm:madez:job:list", "j1");
  await src("HSET", "lm:madez:job:j1:now", "stage", JSON.stringify("active"));
  await src("ZADD", "lm:madez:job:j1:log", 1790000001000, JSON.stringify({ kind: "progress", summary: "Started" }));

  const exp = await exportSpace(src, "madez", {
    version: 2,
    mode: "full",
    gzip: true,
    spaceName: "Mad EZ",
    requireApproval: true,
    approved: true,
  });

  const dst = createMemoryRedis();
  const targetNs = "s-abcdef0123456789abcdef01";

  const dry = await importSpace(dst, targetNs, exp.buffer, { dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.sourceSpace, "madez");
  assert.equal(dry.sourceSpaceName, "Mad EZ");
  assert.equal(dry.mode, "full");
  assert.equal(dry.manifest.agents, 2);
  assert.equal(dry.manifest.plans, 1);
  assert.equal(dry.manifest.milestones, 1);
  assert.equal(dry.manifest.jobs, 1);
  assert.equal(dry.manifest.traces, 1);
  assert.equal(dry.conflicts.length, 0);

  const applied = await importSpace(dst, targetNs, exp.buffer, {
    dryRun: false,
    approved: true,
    recordReceipt: true,
    importedBy: "human:user_1234567890",
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.written.created, dry.wouldCreate);

  // Verify SET index restored cleanly!
  const agents = await dst("SMEMBERS", `lm:${targetNs}:agent:list`);
  assert.deepEqual([...agents].sort(), ["atlas", "quill"]);
  const plans = await dst("SMEMBERS", `lm:${targetNs}:plan:list`);
  assert.deepEqual(plans, ["p1"]);

  // Verify receipt & rev bump
  const receipt = JSON.parse(await dst("GET", `lm:${targetNs}:meta:import`));
  assert.equal(receipt.sourceSpace, "madez");
  assert.equal(receipt.agentCount, 2);
  assert.equal(receipt.importedBy, "human:user_1234567890");
  assert.equal(Number(await dst("GET", `lm:${targetNs}:rev`)), 1);
});

test("v2 import: skipConflicts preserves existing keys while creating missing ones", async () => {
  const redis = createMemoryRedis();
  await redis("SET", "lm:src:agent:a:who", JSON.stringify({ name: "From Bundle" }));
  await redis("SET", "lm:src:agent:b:who", JSON.stringify({ name: "New Agent" }));
  const exp = await exportSpace(redis, "src", { version: 2, mode: "blueprint", approved: true });

  await redis("SET", "lm:dst:agent:a:who", JSON.stringify({ name: "Keep Local" }));
  const res = await importSpace(redis, "dst", exp.json, {
    dryRun: false,
    approved: true,
    skipConflicts: true,
  });
  assert.equal(res.written.created, 1);
  assert.equal(res.written.skippedConflicts, 1);
  assert.deepEqual(JSON.parse(await redis("GET", "lm:dst:agent:a:who")), { name: "Keep Local" });
  assert.deepEqual(JSON.parse(await redis("GET", "lm:dst:agent:b:who")), { name: "New Agent" });
});

test("v2 import: rejects tampered gzip bundle and rejects malformed key segments", async () => {
  const redis = createMemoryRedis();
  await redis("SET", "lm:src:agent:a:who", JSON.stringify({ name: "A" }));
  const exp = await exportSpace(redis, "src", { version: 2, mode: "full", gzip: true, approved: true });
  const tampered = Buffer.from(exp.buffer);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => parseBundle(tampered), SpaceImportError);

  const badObj = JSON.parse((await exportSpace(redis, "src", { version: 2, mode: "full", approved: true })).json);
  badObj.data.other["bad key with space"] = "x";
  // Checksum invalidates tamper
  assert.throws(() => parseBundle(badObj), (e) => e instanceof SpaceImportError && e.code === "checksum_mismatch");
});
