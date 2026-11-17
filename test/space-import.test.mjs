// Space import: the mirror half of space-export. Plan first, checksum gate,
// conflicts refuse, overwrite is explicit, skipped types stay skipped, and a
// round trip preserves the data shape.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { exportSpace } from "../src/http/space-export.mjs";
import { importSpace, parseBundle, SpaceImportError } from "../src/http/space-import.mjs";

async function seed(redis) {
  await redis("HSET", "lm:srcspace:profile:agent:muse", "name", JSON.stringify({ name: "Muse" }), "role", JSON.stringify("agent"));
  await redis("SET", "lm:srcspace:signals:s1", JSON.stringify({ ts: 1700000000000, kind: "status" }));
  await redis("ZADD", "lm:srcspace:timeline:t1", 1700000000000, JSON.stringify({ kind: "progress", ts: 1700000000000 }));
  await redis("SET", "lm:srcspace:decision:trail-1", JSON.stringify({ verdict: "approve" }));
  await redis("HSET", "lm:srcspace:job:alpha:who", "title", JSON.stringify({ title: "Ship it" }), "owner", JSON.stringify("agent:opencode"));
  await redis("HSET", "lm:srcspace:job:alpha:now", "stage", JSON.stringify("active"));
  await redis("ZADD", "lm:srcspace:job:alpha:log", 1700000000000, JSON.stringify({ kind: "progress", summary: "first" }));
  await redis("RPUSH", "lm:srcspace:job:alpha:steps", "one", "two");
  await redis("SET", "lm:srcspace:job:alpha:plain", "raw value");
  await redis("SADD", "lm:srcspace:settype:keep", "member1"); // export skips sets
}

/** Order-insensitive canonical form of a bundle data block. Skipped-type
 *  markers are excluded: the export records them but import restores nothing. */
function canon(data) {
  const out = {};
  for (const [cat, entries] of Object.entries(data)) {
    out[cat] = Object.fromEntries(
      Object.entries(entries || {})
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([, v]) => {
          if (typeof v !== "object" || v === null) return true;
          return !(v.__type && v.skipped);
        })
        .map(([k, v]) => [k, JSON.stringify(v)])
    );
  }
  return JSON.stringify(out);
}

test("space import: round trip preserves the data shape", async () => {
  const redis = createMemoryRedis();
  await seed(redis);
  const exp = await exportSpace(redis, "srcspace", { requireApproval: true, approved: true });
  const bundle = parseBundle(exp.json); // parses AND verifies checksum

  const plan = await importSpace(redis, "dstspace", bundle, { dryRun: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.conflicts.length, 0, "empty target has no conflicts");
  assert.ok(plan.wouldCreate >= 9, "plans every restorable key");
  assert.ok(plan.skipped.some((s) => s.type === "set"), "the set type is reported as skipped");

  const applied = await importSpace(redis, "dstspace", bundle, { dryRun: false, approved: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.written.created, plan.wouldCreate);

  const reExport = await exportSpace(redis, "dstspace", { requireApproval: true, approved: true });
  const rebundle = parseBundle(reExport.json);
  assert.equal(canon(rebundle.data), canon(bundle.data), "data survives the round trip");
  assert.equal(rebundle.data.other["settype:keep"], undefined, "skipped type stays absent");
});

test("space import: existing keys are conflicts and apply refuses them", async () => {
  const redis = createMemoryRedis();
  await seed(redis);
  const bundle = parseBundle((await exportSpace(redis, "srcspace", { requireApproval: true, approved: true })).json);

  const plan = await importSpace(redis, "srcspace", bundle, { dryRun: true }); // importing over itself
  assert.ok(plan.conflicts.length >= 9, "every existing key conflicts");

  await assert.rejects(
    () => importSpace(redis, "srcspace", bundle, { dryRun: false, approved: true }),
    (e) => e instanceof SpaceImportError && e.code === "conflicts"
  );

  const forced = await importSpace(redis, "srcspace", bundle, { dryRun: false, approved: true, overwrite: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.written.overwritten >= 9, "overwrite replaces the existing keys");
});

test("space import: apply without approval refuses", async () => {
  const redis = createMemoryRedis();
  await seed(redis);
  const bundle = parseBundle((await exportSpace(redis, "srcspace", { requireApproval: true, approved: true })).json);
  await assert.rejects(
    () => importSpace(redis, "freshspace", bundle, { dryRun: false, approved: false }),
    (e) => e instanceof SpaceImportError && e.code === "approval_required"
  );
});

test("space import: a tampered bundle fails the checksum before any plan", async () => {
  const redis = createMemoryRedis();
  await seed(redis);
  const json = (await exportSpace(redis, "srcspace", { requireApproval: true, approved: true })).json;
  const bundle = JSON.parse(json);
  bundle.data.decisions["trail-1"] = JSON.stringify({ verdict: "reject" }); // content changed, checksum stale
  assert.throws(() => parseBundle(JSON.stringify(bundle)), (e) => e instanceof SpaceImportError && e.code === "checksum_mismatch");
});

test("space import: wrong format refuses", () => {
  assert.throws(() => parseBundle(JSON.stringify({ format: "something-else", data: {}, checksum: "x" })), (e) => e.code === "invalid_bundle");
});
