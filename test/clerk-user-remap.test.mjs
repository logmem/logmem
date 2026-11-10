import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, listWorkspaces, authorizeSpace } from "../src/http/workspaces.mjs";
import { planUserRemap, applyUserRemap, validatePairs, RemapInputError, RemapRefusedError } from "../scripts/clerk-user-remap.mjs";

const DEV = "user_devAAAAAAAAAAAA", PROD = "user_prodAAAAAAAAAAA";
const DEV2 = "user_devBBBBBBBBBBBB", PROD2 = "user_prodBBBBBBBBBBB";

/** A redis runner that records every command, so a test can prove nothing was written. */
function spy(redis) {
  const calls = [];
  const run = async (cmd, ...args) => {
    calls.push(String(cmd).toUpperCase());
    return redis(cmd, ...args);
  };
  return { run, calls };
}

async function seed() {
  const redis = createMemoryRedis();
  const made = await createWorkspace({ userId: DEV, name: "Acme", firstSpaceName: "Ops", requestId: "request-0001" }, { redis });
  const tenant = "uacct000001";
  await redis("SET", `lm:account:clerk:${DEV}`, tenant);
  await redis("SET", `lm:account:tenant:${tenant}`, DEV);
  return { redis, workspaceId: made.workspace.id, tenant };
}

test("remap: the pair list is checked before any read", () => {
  assert.throws(() => validatePairs([]), RemapInputError);
  assert.throws(() => validatePairs([{ from: DEV, to: DEV }]), /itself/);
  assert.throws(() => validatePairs([{ from: "nope", to: PROD }]), /two Clerk user ids/);
  assert.throws(() => validatePairs([{ from: DEV, to: PROD }, { from: DEV, to: PROD2 }]), /repeats a "from"/);
  assert.throws(() => validatePairs([{ from: DEV, to: PROD }, { from: DEV2, to: PROD }]), /repeats a "to"/);
  assert.throws(() => validatePairs([{ from: DEV, to: PROD }, { from: PROD, to: PROD2 }]), /Chains/);
  assert.throws(() => validatePairs([{ from: DEV, to: PROD, email: "x" }]), /extra fields/);
  assert.deepEqual(validatePairs([{ from: DEV, to: PROD }]), [{ from: DEV, to: PROD }]);
});

test("remap: plans the account, the workspace record, the indexes, and writes nothing", async () => {
  const { redis, workspaceId, tenant } = await seed();
  const before = JSON.stringify(await redis("GET", `lm:workspace:record:${workspaceId}`));
  const { run, calls } = spy(redis);
  const plan = await planUserRemap({ redis: run, pairs: [{ from: DEV, to: PROD }] });

  assert.equal(plan.applied, false);
  assert.deepEqual(plan.totals, { pairs: 1, wouldMove: 1, conflict: 0, nothingToMove: 0, ops: plan.results[0].ops.length, workspaces: 1 });
  const r = plan.results[0];
  assert.equal(r.status, "would-move");
  assert.deepEqual(r.account, { tenant });
  assert.equal(r.workspaces[0].id, workspaceId);
  assert.equal(r.workspaces[0].role, "owner");
  const has = (op, key) => r.ops.some((o) => o.op === op && o.key === key);
  assert.ok(has("SET", `lm:account:clerk:${PROD}`));
  assert.ok(has("SET", `lm:account:tenant:${tenant}`));
  assert.ok(has("DEL", `lm:account:clerk:${DEV}`));
  assert.ok(has("REWRITE", `lm:workspace:record:${workspaceId}`));
  assert.ok(has("SADD", `lm:workspace:user:${PROD}`));
  assert.ok(has("SREM", `lm:workspace:user:${DEV}`));
  assert.ok(has("SADD", `lm:workspace:owned:${PROD}`));

  const writes = calls.filter((c) => !["GET", "SMEMBERS", "EXISTS"].includes(c));
  assert.deepEqual(writes, [], "the plan uses read commands only");
  assert.equal(JSON.stringify(await redis("GET", `lm:workspace:record:${workspaceId}`)), before);
  assert.equal((await listWorkspaces({ userId: DEV }, { redis })).length, 1, "the source id still has its workspace");
  assert.equal((await listWorkspaces({ userId: PROD }, { redis })).length, 0, "the target id has nothing yet");
});

test("remap: a target that already signed in is a conflict, not a silent overwrite", async () => {
  const { redis } = await seed();
  await redis("SET", `lm:account:clerk:${PROD}`, "uacct000002");
  const plan = await planUserRemap({ redis, pairs: [{ from: DEV, to: PROD }] });
  assert.equal(plan.results[0].status, "conflict");
  assert.equal(plan.results[0].conflicts[0].code, "target_has_account");
  assert.equal(plan.totals.conflict, 1);
});

test("remap: an owner mismatch and a target that is already a member are conflicts", async () => {
  const { redis, tenant } = await seed();
  await redis("SET", `lm:account:tenant:${tenant}`, DEV2);
  const a = await planUserRemap({ redis, pairs: [{ from: DEV, to: PROD }] });
  assert.ok(a.results[0].conflicts.some((c) => c.code === "owner_mismatch"));

  const s = await seed();
  const raw = JSON.parse(await s.redis("GET", `lm:workspace:record:${s.workspaceId}`));
  raw.members[PROD] = { role: "admin", status: "active", spaces: {} };
  await s.redis("SET", `lm:workspace:record:${s.workspaceId}`, JSON.stringify(raw));
  const b = await planUserRemap({ redis: s.redis, pairs: [{ from: DEV, to: PROD }] });
  assert.ok(b.results[0].conflicts.some((c) => c.code === "target_is_member"));
});

test("remap: an id with no records is reported, and admin records are planned without their values", async () => {
  const { redis } = await seed();
  await redis("SET", `lm:admin:role:${DEV}`, JSON.stringify({ role: "super", secret_note: "do-not-print" }));
  const plan = await planUserRemap({ redis, pairs: [{ from: DEV, to: PROD }, { from: DEV2, to: PROD2 }] });
  assert.equal(plan.results[1].status, "nothing-to-move");
  assert.ok(plan.results[0].ops.some((o) => o.op === "COPY" && o.key === `lm:admin:role:${PROD}`));
  assert.equal(JSON.stringify(plan).includes("do-not-print"), false);
});

const PAIRS = [{ from: DEV, to: PROD }];
const snapshot = async (redis, workspaceId, tenant) => JSON.stringify([
  await redis("GET", `lm:workspace:record:${workspaceId}`), await redis("GET", `lm:account:clerk:${DEV}`),
  await redis("GET", `lm:account:clerk:${PROD}`), await redis("GET", `lm:account:tenant:${tenant}`),
  await redis("SMEMBERS", `lm:workspace:user:${DEV}`), await redis("SMEMBERS", `lm:workspace:user:${PROD}`),
]);

/** The same checks for the in-memory store and for a real Redis server. */
async function assertMoved(redis, { workspaceId, tenant, spaceId }) {
  assert.equal(await redis("GET", `lm:account:clerk:${PROD}`), tenant);
  assert.equal(await redis("GET", `lm:account:clerk:${DEV}`), null);
  assert.equal(await redis("GET", `lm:account:tenant:${tenant}`), PROD);
  const mine = await listWorkspaces({ userId: PROD }, { redis });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, "owner");
  assert.equal((await listWorkspaces({ userId: DEV }, { redis })).length, 0);
  const access = await authorizeSpace({ userId: PROD, workspaceId, spaceId, action: "write" }, { redis });
  assert.equal(access.person, `human:${PROD}`);
  await assert.rejects(authorizeSpace({ userId: DEV, workspaceId, spaceId, action: "read" }, { redis }));
  const w = JSON.parse(await redis("GET", `lm:workspace:record:${workspaceId}`));
  assert.equal(w.version, 2);
  assert.equal(String(await redis("GET", `lm:workspace:version:${workspaceId}`)), "2");
  assert.equal(w.audit.at(-1).kind, "member-id-remapped");
  assert.equal(w.audit[0].by, `human:${DEV}`, "history keeps the id that acted");
  assert.deepEqual((await redis("SMEMBERS", `lm:workspace:owned:${PROD}`)).map(String), [workspaceId]);
  assert.equal(JSON.parse(await redis("GET", `lm:admin:role:${PROD}`)).role, "admin");
  assert.equal(Number(await redis("EXISTS", `lm:admin:role:${DEV}`)), 0);
}

async function seedFull(redis) {
  const made = await createWorkspace({ userId: DEV, name: "Acme", firstSpaceName: "Ops", requestId: "request-0001" }, { redis });
  const tenant = "uacct000001";
  await redis("SET", `lm:account:clerk:${DEV}`, tenant);
  await redis("SET", `lm:account:tenant:${tenant}`, DEV);
  await redis("SET", `lm:admin:role:${DEV}`, JSON.stringify({ role: "admin", by: "test", at: 1 }));
  return { workspaceId: made.workspace.id, tenant, spaceId: made.space.id };
}

test("remap apply: refuses without the reviewed plan hash, and writes nothing", async () => {
  const redis = createMemoryRedis();
  const ids = await seedFull(redis);
  const before = await snapshot(redis, ids.workspaceId, ids.tenant);
  await assert.rejects(applyUserRemap({ redis, pairs: PAIRS }), RemapRefusedError);
  await assert.rejects(applyUserRemap({ redis, pairs: PAIRS, confirm: "0".repeat(64) }), /data changed/);
  assert.equal(await snapshot(redis, ids.workspaceId, ids.tenant), before);
});

test("remap apply: refuses a plan with a conflict", async () => {
  const redis = createMemoryRedis();
  const ids = await seedFull(redis);
  await redis("SET", `lm:account:clerk:${PROD}`, "uacct000002");
  const plan = await planUserRemap({ redis, pairs: PAIRS });
  const before = await snapshot(redis, ids.workspaceId, ids.tenant);
  await assert.rejects(applyUserRemap({ redis, pairs: PAIRS, confirm: plan.planHash }), /conflict/);
  assert.equal(await snapshot(redis, ids.workspaceId, ids.tenant), before);
});

test("remap apply: moves the account, the workspace and the admin role with the reviewed hash", async () => {
  const redis = createMemoryRedis();
  const ids = await seedFull(redis);
  const plan = await planUserRemap({ redis, pairs: PAIRS });
  assert.match(plan.planHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(plan).includes('"members"'), false, "the printed plan carries no record body");
  const out = await applyUserRemap({ redis, pairs: PAIRS, confirm: plan.planHash, now: () => 1_800_000_000_000 });
  assert.deepEqual(out.totals, { pairs: 1, moved: 1, changed: 0, nothingToMove: 0 });
  await assertMoved(redis, ids);
  // A second run with the old hash is refused: the target now holds the account.
  await assert.rejects(applyUserRemap({ redis, pairs: PAIRS, confirm: plan.planHash }), RemapRefusedError);
  await assertMoved(redis, ids);
});

test("remap apply: a record that changes after the plan is read is not written", async () => {
  const redis = createMemoryRedis();
  const ids = await seedFull(redis);
  const plan = await planUserRemap({ redis, pairs: PAIRS });
  // Change the workspace just before the atomic script runs, as a live user would.
  const racing = async (cmd, ...args) => {
    if (String(cmd).toUpperCase() === "EVAL") {
      const w = JSON.parse(await redis("GET", `lm:workspace:record:${ids.workspaceId}`));
      w.name = "Renamed meanwhile";
      await redis("SET", `lm:workspace:record:${ids.workspaceId}`, JSON.stringify(w));
    }
    return redis(cmd, ...args);
  };
  const out = await applyUserRemap({ redis: racing, pairs: PAIRS, confirm: plan.planHash });
  assert.deepEqual(out.results[0], { from: DEV, to: PROD, status: "changed", reason: "workspace_changed" });
  assert.equal(await redis("GET", `lm:account:clerk:${DEV}`), ids.tenant, "the account did not move either");
  assert.equal(await redis("GET", `lm:account:clerk:${PROD}`), null);
  assert.equal((await listWorkspaces({ userId: DEV }, { redis })).length, 1);
});

test("remap: the command line needs a plan hash to apply", () => {
  const run = (...a) => spawnSync(process.execPath, ["scripts/clerk-user-remap.mjs", ...a], { encoding: "utf8" });
  const noHash = run("--map", "x.json", "--apply");
  assert.equal(noHash.status, 2);
  assert.match(noHash.stderr, /plan hash/);
  assert.equal(run("--map", "x.json", "--confirm", "a".repeat(64)).status, 2, "--confirm alone is refused");
  assert.equal(run("--map", "x.json", "--force").status, 2, "unknown flags are refused");
  assert.equal(run().status, 2);
});

// The atomic script is Lua. The in-memory store runs a JavaScript twin, so this test runs the
// real Lua on a real server when one is installed. It starts its own server on a spare port.
const REDIS_BIN = ["/opt/homebrew/bin/redis-server", "/usr/local/bin/redis-server", "/usr/bin/redis-server"].find((p) => existsSync(p));
test("remap apply: the Lua script moves and refuses the same way on a real Redis", { skip: !REDIS_BIN && "redis-server is not installed" }, async () => {
  const { nativeRedisCall } = await import("../src/lib/redis-native.mjs");
  const dir = mkdtempSync(join(tmpdir(), "lm-remap-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(REDIS_BIN, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir], { stdio: "ignore" });
  const uri = `redis://127.0.0.1:${port}`;
  const redis = (...cmd) => nativeRedisCall(uri, ...cmd);
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await redis("PING").then((r) => r === "PONG", () => false);
      if (!up) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(up, "the test server started");
    const ids = await seedFull(redis);

    // Drift first: the Lua check must refuse and write nothing.
    const stale = await planUserRemap({ redis, pairs: PAIRS });
    const racing = async (cmd, ...args) => {
      if (String(cmd).toUpperCase() === "EVAL" && String(args[0]).includes("target_has_account")) await redis("SADD", `lm:workspace:user:${DEV}`, "wextra0001");
      return redis(cmd, ...args);
    };
    const refused = await applyUserRemap({ redis: racing, pairs: PAIRS, confirm: stale.planHash });
    assert.equal(refused.results[0].reason, "membership_changed");
    assert.equal(await redis("GET", `lm:account:clerk:${PROD}`), null);
    await redis("SREM", `lm:workspace:user:${DEV}`, "wextra0001");

    const plan = await planUserRemap({ redis, pairs: PAIRS });
    const out = await applyUserRemap({ redis, pairs: PAIRS, confirm: plan.planHash });
    assert.equal(out.totals.moved, 1);
    await assertMoved(redis, ids);
    assert.equal(Number(await redis("LLEN", `lm:workspace:audit:${ids.workspaceId}`)), 2);
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
