// Phase 6.2 slice 4: plan and usage rows from real catalog, meter and workspace data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace } from "../src/http/workspaces.mjs";
import { meter } from "../cloud/meter/index.mjs";
import { namespaceFor } from "../cloud/tenants/index.mjs";
import { planUsageFor } from "../src/http/plan-usage.mjs";
import { createHandler } from "../api/plan.mjs";

const alice = "user_alice00000001", bob = "user_bob0000000001", member = "user_member000001";
const rowsOf = (rows, key) => rows.find((r) => r.key === key);

async function fixture(plan = "free", userId = alice) {
  const redis = createMemoryRedis();
  const { workspace } = await createWorkspace(
    { userId, name: "Biz", firstSpaceName: "Ops", requestId: "req-plan-1", plan },
    { redis }
  );
  return { redis, workspace };
}

test("free plan rows and usage come from the catalog, meter and workspace", async () => {
  const { redis, workspace } = await fixture();
  await meter(redis, workspace.tenantId, "add", 7, { plan: { limits: { add: 1000 }, grace_ratio: 0.1 } });
  await redis("SADD", `lm:${namespaceFor(workspace.tenantId)}:agents`, "agent-one", "agent-two");

  const out = await planUsageFor({ userId: alice, deps: { redis } });
  assert.equal(out.ok, true);

  const plan = out.data.plan;
  assert.equal(rowsOf(plan, "plan").value, "Free");
  assert.equal(rowsOf(plan, "price").value, "Free");
  assert.equal(rowsOf(plan, "spaces_limit").value, 1);
  assert.equal(rowsOf(plan, "agents_limit").value, 2);
  assert.equal(rowsOf(plan, "history").value, "7 days");
  assert.equal(rowsOf(plan, "adds_quota").value, 1000);
  assert.equal(rowsOf(plan, "recalls_quota").value, 100);

  const usage = out.data.usage;
  assert.equal(rowsOf(usage, "spaces_used").value, 1);
  assert.equal(rowsOf(usage, "spaces_used").state, "at_limit", "free includes one space and one is in use");
  assert.equal(rowsOf(usage, "agents_used").value, 2);
  assert.equal(rowsOf(usage, "agents_used").state, "at_limit");
  assert.equal(rowsOf(usage, "adds_used").value, 7);
  assert.equal(rowsOf(usage, "adds_used").state, undefined);
  assert.equal(rowsOf(usage, "adds_state").value, 1093, "1000 plus10% grace minus7 used");
  assert.match(rowsOf(usage, "usage_month").value, /^\d{6}$/);
});

test("a paid workspace reports its own catalog numbers", async () => {
  const { redis } = await fixture("pro");
  const out = await planUsageFor({ userId: alice, deps: { redis } });
  assert.equal(rowsOf(out.data.plan, "plan").value, "Pro");
  assert.equal(rowsOf(out.data.plan, "price").value, "$49/mo");
  assert.equal(rowsOf(out.data.plan, "spaces_limit").value, 3);
  assert.equal(rowsOf(out.data.plan, "adds_quota").value, 50000);
  assert.equal(rowsOf(out.data.usage, "spaces_used").state, undefined, "one space of three is not at limit");
});

test("no workspace is an honest empty state, not invented rows", async () => {
  const redis = createMemoryRedis();
  const out = await planUsageFor({ userId: bob, deps: { redis } });
  assert.equal(out.ok, true);
  assert.equal(out.data.plan.length, 1);
  assert.equal(out.data.plan[0].state, "no_workspace");
  assert.equal(out.data.plan[0].value, null);
  assert.equal(out.data.usage.length, 0);
});

test("a plain member cannot read billing rows", async () => {
  const { redis, workspace } = await fixture();
  const key = `lm:workspace:record:${workspace.id}`;
  const w = JSON.parse(await redis("GET", key));
  w.members[member] = { role: "member", status: "active" };
  await redis("SET", key, JSON.stringify(w));
  await redis("SADD", `lm:workspace:user:${member}`, workspace.id);
  await assert.rejects(
    planUsageFor({ userId: member, deps: { redis } }),
    (e) => e.code === "forbidden" && e.status === 403
  );
});

test("handler: GET returns rows, other methods405, no session401", async () => {
  const { redis } = await fixture();
  const res = () => ({ _h: {}, setHeader(k, v) { this._h[k] = v; }, status(c) { this.c = c; return this; }, json(j) { this.body = j; return this; } });
  const handler = (session) => createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1" }, redis, session });

  const ok = res();
  await handler(async () => ({ status: "signed-in", userId: alice }))({ method: "GET" }, ok);
  assert.equal(ok.c, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.data.plan.length >= 7);

  const wrong = res();
  await handler(async () => ({ status: "signed-in", userId: alice }))({ method: "POST" }, wrong);
  assert.equal(wrong.c, 405);

  const out = res();
  await handler(async () => ({ status: "signed-out" }))({ method: "GET" }, out);
  assert.equal(out.c, 401);
  assert.deepEqual(out.body, { error: "sign_in_required" });
});
