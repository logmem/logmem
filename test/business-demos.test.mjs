import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedBusinessDemos,
  BUSINESS_DEMOS,
} from "../scripts/seed-business-demos.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { buildView } from "../src/http/view.mjs";

test("business samples: five isolated spaces use real jobs, handoffs, decisions and views", async () => {
  const redis = createMemoryRedis();
  const seeded = await seedBusinessDemos(redis);
  assert.equal(seeded.length, 5);
  assert.equal(new Set(seeded.map((x) => x.space)).size, 5);
  for (const space of seeded) {
    const jobs = await buildView(redis, space.space, "jobs");
    const serialized = JSON.stringify(jobs);
    for (const job of space.jobs) assert.ok(serialized.includes(job), job);
    const agents = await buildView(redis, space.space, "agents");
    assert.ok(JSON.stringify(agents).includes("claude"));
    const decisions = await buildView(redis, space.space, "decisions");
    assert.equal(decisions.waiting.length, 1);
    assert.equal(decisions.decided.length, 0);
    const first = await buildView(redis, space.space, "job", {
      id: space.jobs[0],
    });
    assert.equal(first.now.stage, "done");
    const blocked = await buildView(redis, space.space, "job", {
      id: space.jobs[2],
    });
    assert.equal(blocked.now.stage, "blocked");
    const second = await buildView(redis, space.space, "job", {
      id: space.jobs[1],
    });
    assert.ok(second.log.some((e) => e.kind === "accepted"));
    const pending = await buildView(redis, space.space, "job", {
      id: space.jobs[4],
    });
    assert.ok(pending.log.some((e) => e.kind === "handoff"));
    assert.ok(!pending.log.some((e) => e.kind === "accepted"));
    for (const other of BUSINESS_DEMOS.filter((x) => x.id !== space.space)) {
      assert.ok(
        !serialized.includes(other.jobs[0]),
        "another sample leaked into this view",
      );
    }
  }
  assert.ok(
    [...redis._data.keys()].every((k) => k.startsWith("lm:demo-")),
    "seed touched a non-demo key",
  );
});
