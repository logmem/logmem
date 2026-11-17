// Phase 6.2 slice 3: space export and import routes with dry run and approval gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace, createSpace } from "../src/http/workspaces.mjs";
import { createHandler } from "../api/space-io.mjs";

const alice = "user_alice00000001", bob = "user_bob0000000001";
const ORIGIN = "http://t.local";

const reqFor = (body, { userId = alice, method = "POST", intent = true, raw = false } = {}) => {
  const base = {
    method,
    url: `${ORIGIN}/api/space-io`,
    headers: { origin: ORIGIN, ...(intent ? { "x-logmem-intent": "space-io" } : {}) },
  };
  if (raw) {
    // Attach the request fields onto the stream itself so the async iterator survives.
    const stream = Readable.from([JSON.stringify(body)]);
    Object.assign(stream, base);
    return stream;
  }
  base.body = body;
  return base;
};
const resFor = () => ({
  _h: {},
  setHeader(k, v) { this._h[k] = v; },
  status(c) { this.c = c; return this; },
  json(j) { this.body = j; return this; },
});
const handlerFor = (redis, userId = alice) =>
  createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1" }, redis, session: async () => ({ status: "signed-in", userId }) });

async function fixture() {
  const redis = createMemoryRedis();
  const { workspace, space } = await createWorkspace(
    { userId: alice, name: "Biz", firstSpaceName: "Ops", requestId: "req-io-1" },
    { redis }
  );
  const { space: space2 } = await createSpace(
    { userId: alice, workspaceId: workspace.id, name: "Second", requestId: "req-io-2" },
    { redis }
  );
  await redis("SET", `lm:${space.namespace}:signals:s1`, JSON.stringify({ ts: 1700000000000, kind: "status" }));
  await redis("HSET", `lm:${space.namespace}:profile:agent:muse`, "name", JSON.stringify({ name: "Muse" }));
  return { redis, wsId: workspace.id, spA: space.id, spB: space2.id, nsA: space.namespace, nsB: space2.namespace };
}
const call = async (h, body, opts) => { const res = resFor(); await h(reqFor(body, opts), res); return res; };

test("export-space defaults to a dry run and withholds the payload", async () => {
  const f = await fixture();
  const res = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA });
  assert.equal(res.c, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.json, undefined, "dry run never returns the payload");
  assert.ok(res.body.totalKeys >= 2);
  assert.ok(res.body.counts.signals >= 1);
});

test("a real export needs dryRun false AND approved true", async () => {
  const f = await fixture();
  const denied = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false });
  assert.equal(denied.c, 403);
  assert.deepEqual(denied.body, { error: "approval_required" });

  const allowed = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false, approved: true });
  assert.equal(allowed.c, 200);
  assert.equal(typeof allowed.body.json, "string", "approved real export carries the bundle");
  const bundle = JSON.parse(allowed.body.json);
  assert.equal(bundle.format, "logmem-space-backup-v1");
});

test("import-plan writes nothing and reports the plan", async () => {
  const f = await fixture();
  const exp = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false, approved: true });
  const plan = await call(handlerFor(f.redis), { action: "import-plan", workspaceId: f.wsId, spaceId: f.spB, bundle: exp.body.json });
  assert.equal(plan.c, 200);
  assert.equal(plan.body.ok, true);
  assert.equal(plan.body.dryRun, true);
  assert.ok(plan.body.wouldCreate >= 2);
  assert.equal(plan.body.conflicts.length, 0);

  const check = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spB });
  assert.equal(check.body.totalKeys, 0, "plan must not write");
});

test("import-apply round trips a bundle into an empty space", async () => {
  const f = await fixture();
  const exp = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false, approved: true });
  const applied = await call(handlerFor(f.redis), { action: "import-apply", workspaceId: f.wsId, spaceId: f.spB, bundle: exp.body.json, approved: true });
  assert.equal(applied.c, 200);
  assert.equal(applied.body.ok, true);
  assert.ok(applied.body.written.created >= 2);

  const after = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spB });
  assert.ok(after.body.totalKeys >= 2, "imported keys are visible to a fresh export");
});

test("import-apply refuses without approval and refuses conflicts", async () => {
  const f = await fixture();
  const exp = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false, approved: true });

  const noApproval = await call(handlerFor(f.redis), { action: "import-apply", workspaceId: f.wsId, spaceId: f.spB, bundle: exp.body.json });
  assert.equal(noApproval.c, 403);
  assert.deepEqual(noApproval.body, { error: "approval_required" });

  const conflict = await call(handlerFor(f.redis), { action: "import-apply", workspaceId: f.wsId, spaceId: f.spA, bundle: exp.body.json, approved: true });
  assert.equal(conflict.c, 400);
  assert.deepEqual(conflict.body, { error: "conflicts" });
});

test("guards: intent, method, membership, action, session", async () => {
  const f = await fixture();
  const h = handlerFor(f.redis);

  const noIntent = await call(h, { action: "export-space", workspaceId: f.wsId, spaceId: f.spA }, { intent: false });
  assert.equal(noIntent.c, 403);
  assert.deepEqual(noIntent.body, { error: "request_not_allowed" });

  const get = await call(h, { action: "export-space", workspaceId: f.wsId, spaceId: f.spA }, { method: "GET" });
  assert.equal(get.c, 405);

  const stranger = await call(handlerFor(f.redis, bob), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA });
  assert.equal(stranger.c, 404, "a non-member gets the house-standard not_found, as workspaces tests assert");
  assert.deepEqual(stranger.body, { error: "not_found" });

  const badAction = await call(h, { action: "explode", workspaceId: f.wsId, spaceId: f.spA });
  assert.equal(badAction.c, 400);
  assert.deepEqual(badAction.body, { error: "invalid_action" });

  const signedOut = await call(
    createHandler({ env: { LOGMEM_CUSTOMER_DASHBOARD: "1" }, redis: f.redis, session: async () => ({ status: "signed-out" }) }),
    { action: "export-space", workspaceId: f.wsId, spaceId: f.spA }
  );
  assert.equal(signedOut.c, 401);
  assert.deepEqual(signedOut.body, { error: "sign_in_required" });
});

test("a bundle arrives through the raw body path, not only req.body", async () => {
  const f = await fixture();
  const exp = await call(handlerFor(f.redis), { action: "export-space", workspaceId: f.wsId, spaceId: f.spA, dryRun: false, approved: true });
  const plan = await call(handlerFor(f.redis), { action: "import-plan", workspaceId: f.wsId, spaceId: f.spB, bundle: exp.body.json }, { raw: true });
  assert.equal(plan.c, 200);
  assert.ok(plan.body.wouldCreate >= 2, "streamed body parses and plans");
});
