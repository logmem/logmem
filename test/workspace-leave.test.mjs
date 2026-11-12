// Phase 6.2 leave workspace: the signed-in person leaves, the last active
// owner cannot, repeats replay, and the audit keeps the departure.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createWorkspace, setMembership, leaveWorkspace, readWorkspace, WorkspaceError } from "../src/http/workspaces.mjs";
import { createHandler } from "../api/workspaces.mjs";
import { mockReq, mockRes } from "./oauth-helpers.mjs";

const OWNER = "user_owner000001";
const MEMBER = "user_member00001";
const SECOND = "user_secondowner01";
const STRANGER = "user_stranger0001";

async function world() {
  const redis = createMemoryRedis();
  let t = 1700000000000;
  const deps = { redis, now: () => t, limits: { ownedWorkspaces: 3 } };
  const created = await createWorkspace({ userId: OWNER, name: "Biz", firstSpaceName: "Ops", requestId: "create-0001" }, deps);
  return { redis, deps, workspaceId: created.workspace.id, spaceId: created.space.id, bump: () => (t += 1000) };
}

test("a member leaves: membership and index gone, audit keeps the departure", async () => {
  const w = await world();
  await setMembership({ actorId: OWNER, workspaceId: w.workspaceId, userId: MEMBER, role: "member", spaces: {}, requestId: "member-0001" }, w.deps);

  const res = await leaveWorkspace({ userId: MEMBER, workspaceId: w.workspaceId, requestId: "leave-0001" }, w.deps);
  assert.equal(res.ok, true);
  assert.equal(res.left, true);

  const { w: after } = await readWorkspace(w.redis, w.workspaceId);
  assert.equal(after.members[MEMBER], undefined, "member removed from the record");
  assert.ok(after.members[OWNER], "owner stays");
  const last = after.audit.at(-1);
  assert.equal(last.kind, "member-left");
  assert.equal(last.userId, MEMBER);
  assert.equal(last.by, `human:${MEMBER}`);
  assert.equal(await w.redis("EXISTS", `lm:workspace:user:${MEMBER}`), 0, "index key removed");
});

test("the last active owner cannot leave", async () => {
  const w = await world();
  await assert.rejects(
    () => leaveWorkspace({ userId: OWNER, workspaceId: w.workspaceId, requestId: "leave-own-1" }, w.deps),
    (e) => e instanceof WorkspaceError && e.status === 409 && /last_owner/.test(e.code)
  );
  const { w: after } = await readWorkspace(w.redis, w.workspaceId);
  assert.ok(after.members[OWNER], "owner unchanged after refusal");
});

test("an owner leaves once a second active owner exists", async () => {
  const w = await world();
  const { w: before } = await readWorkspace(w.redis, w.workspaceId);
  await setMembership({ actorId: OWNER, workspaceId: w.workspaceId, userId: SECOND, role: "owner", spaces: { [w.spaceId]: { role: "editor", canApprove: true } }, requestId: "member-0002" }, w.deps);
  const res = await leaveWorkspace({ userId: OWNER, workspaceId: w.workspaceId, requestId: "leave-own-2" }, w.deps);
  assert.equal(res.left, true);
  const { w: after } = await readWorkspace(w.redis, w.workspaceId);
  assert.equal(after.members[OWNER], undefined);
  assert.ok(after.members[SECOND], "the second owner remains");
  assert.ok(after.version > before.version, "version moved");
});

test("a repeat of the same request replays without a second audit entry", async () => {
  const w = await world();
  await setMembership({ actorId: OWNER, workspaceId: w.workspaceId, userId: MEMBER, role: "member", spaces: {}, requestId: "member-0003" }, w.deps);
  const first = await leaveWorkspace({ userId: MEMBER, workspaceId: w.workspaceId, requestId: "leave-dup" }, w.deps);
  const second = await leaveWorkspace({ userId: MEMBER, workspaceId: w.workspaceId, requestId: "leave-dup" }, w.deps);
  assert.equal(first.left, true);
  assert.equal(second.left, true);
  assert.equal(second.created, false, "second call is the replay");
  const { w: after } = await readWorkspace(w.redis, w.workspaceId);
  const departures = after.audit.filter((a) => a.kind === "member-left");
  assert.equal(departures.length, 1, "exactly one audit entry");
});

test("a non member gets not_found", async () => {
  const w = await world();
  await assert.rejects(
    () => leaveWorkspace({ userId: STRANGER, workspaceId: w.workspaceId, requestId: "leave-none" }, w.deps),
    (e) => e instanceof WorkspaceError && e.status === 404
  );
});

test("the workspaces handler dispatches leave-workspace", async () => {
  const w = await world();
  await setMembership({ actorId: OWNER, workspaceId: w.workspaceId, userId: MEMBER, role: "member", spaces: {}, requestId: "member-0004" }, w.deps);
  const deps = {
    redis: w.redis,
    env: { LOGMEM_CUSTOMER_DASHBOARD: "1", LOGMEM_SIGNUP_OPEN: "1" },
    session: async () => ({ status: "signed-in", userId: MEMBER, email: "m@example.com" }),
    now: w.deps.now,
  };
  const handler = createHandler(deps);
  const r = mockRes();
  await handler(mockReq({
    method: "POST",
    url: "/api/workspaces",
    headers: { origin: "https://logmem.test", host: "logmem.test", "x-logmem-intent": "workspace" },
    body: { action: "leave-workspace", workspaceId: w.workspaceId, requestId: "leave-http-1" },
  }), r);
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body);
  assert.equal(body.left, true);
  assert.equal(body.ok, true);
});
