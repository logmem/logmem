import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace, listWorkspaces } from "../src/http/workspaces.mjs";
import { planUserRemap, validatePairs, RemapInputError } from "../scripts/clerk-user-remap.mjs";

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

test("remap: the command line refuses --apply", () => {
  const out = spawnSync(process.execPath, ["scripts/clerk-user-remap.mjs", "--apply", "--map", "x.json"], { encoding: "utf8" });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Apply is not built/);
});
