// logmem_close on Inbox item ids, including mention/request items that are not handoffs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";
import { computeItemId, createCoordItem, getCoordItem } from "../src/core/coord.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function fixture() {
  const redis = createMemoryRedis();
  let t = 1792687770000;
  const now = () => (t += 1000);
  const mk = (sid) => createLogmem({ workRules: "warn", redis, space: "madez", surface: "test", sessionId: sid, now });
  return { mk };
}

async function roster(mk, ids) {
  const agents = {};
  for (const id of ids) {
    agents[id] = mk(id);
    const started = await sc(agents[id], "logmem_start", { agent: id });
    assert.equal(started.ok, true, started.error);
  }
  return agents;
}

// These ids are the real madez Inbox rows for trail polarPresence-20261105.
// They hash as type "request", one recipient each, not as handoffs.
const TRAIL = "polarPresence-20261105";
const CHIEF_ID = "ci_3eb8374a2c281db1c7e7f548";
const AVERY_ID = "ci_d299ad6c88a125d72e6d5a85";

async function plantGroupMention(store) {
  assert.equal(computeItemId("madez", "request", TRAIL, "chief-of-staff"), CHIEF_ID);
  assert.equal(computeItemId("madez", "request", TRAIL, "avery"), AVERY_ID);
  const summary = "@chief-of-staff @avery @claude-code are you here?";
  for (const who of ["chief-of-staff", "avery", "claude-code"]) {
    const created = await createCoordItem(store, {
      space: "madez",
      type: "request",
      requestTrail: TRAIL,
      from: "",
      to: `agent:${who}`,
      where: "channel:agent-coordination",
      summary,
      createdAt: 1790000000000,
    });
    assert.equal(created.ok, true, created.status);
  }
}

test("a recipient closes a real handoff by its Inbox item id", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["polar", "avery", "claude-code"]);
  const { polar, avery } = agents;
  const claude = agents["claude-code"];
  const ho = await sc(polar, "logmem_handoff", {
    to: ["avery", "claude-code"],
    summary: "Review the note",
    where: "job:review",
  });
  assert.equal(ho.ok, true, ho.error);
  const averyId = computeItemId("madez", "handoff", ho.trail, "avery");
  const claudeId = computeItemId("madez", "handoff", ho.trail, "claude-code");

  const closed = await sc(avery, "logmem_close", { item: averyId, reason: "stale: shipped" });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.item_id, averyId);
  assert.equal(closed.closed_by, "agent:avery");
  const item = await getCoordItem(polar.ctx.store, "madez", averyId);
  assert.equal(item.response, "declined");
  assert.equal(item.settled_by, "agent:avery");
  assert.equal(item.disposition, "closed: stale: shipped");
  assert.equal((await getCoordItem(polar.ctx.store, "madez", claudeId)).response, "open");
  const row = (await polar.ctx.store.readLog("agent", "avery")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.payload.closed_by, "agent:avery");
  assert.equal(row.payload.reason, "stale: shipped");
  assert.equal(row.payload.item, averyId);
  assert.equal((await sc(claude, "logmem_sync", {})).counts.total, 1);
});

test("a group mention with no handoff and no sender closes per recipient", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["chief-of-staff", "avery", "claude-code", "scribe"]);
  const store = agents.avery.ctx.store;
  await plantGroupMention(store);
  const chief = await getCoordItem(store, "madez", CHIEF_ID);
  assert.equal(chief.type, "request");
  assert.equal(chief.from, "");
  assert.equal(chief.request_trail, TRAIL);
  assert.equal((await store.readLog("agent", "avery")).some((e) => e.kind === "handoff"), false);

  const blank = await sc(agents.avery, "logmem_close", { item: AVERY_ID, reason: "   " });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /reason is required/);
  assert.equal((await getCoordItem(store, "madez", AVERY_ID)).response, "open");

  const missing = await sc(agents.avery, "logmem_close", { item: "ci_000000000000000000000000", reason: "gone" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not found/);

  const otherPart = await sc(agents.avery, "logmem_close", { item: CHIEF_ID, reason: "not my part" });
  assert.equal(otherPart.ok, false);
  assert.match(otherPart.error, /forbidden/);
  const stranger = await sc(agents.scribe, "logmem_close", { item: AVERY_ID, reason: "not mine" });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /forbidden/);
  assert.equal((await getCoordItem(store, "madez", AVERY_ID)).response, "open");
  assert.equal((await getCoordItem(store, "madez", CHIEF_ID)).response, "open");

  const closed = await sc(agents.avery, "logmem_close", { item: AVERY_ID, reason: "stale: already in the room" });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.item_id, AVERY_ID);
  assert.equal(closed.closed_by, "agent:avery");
  const averyItem = await getCoordItem(store, "madez", AVERY_ID);
  assert.equal(averyItem.response, "declined");
  assert.equal(averyItem.settled_by, "agent:avery");
  assert.equal(averyItem.disposition, "closed: stale: already in the room");
  assert.equal((await getCoordItem(store, "madez", CHIEF_ID)).response, "open");
  // The handoff id for this trail is a different row and stays absent.
  assert.equal(await getCoordItem(store, "madez", computeItemId("madez", "handoff", TRAIL, "avery")), null);
  const row = (await store.readLog("agent", "avery")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.by, "agent:avery");
  assert.equal(row.payload.closed_by, "agent:avery");
  assert.equal(row.payload.reason, "stale: already in the room");
  assert.equal(row.payload.item, AVERY_ID);
  assert.equal(row.origin, TRAIL);
  const onChannel = (await store.readLog("channel", "agent-coordination")).find((e) => e.payload && e.payload.item === AVERY_ID);
  assert.equal(onChannel.payload.closed_by, "agent:avery");

  const claudeId = computeItemId("madez", "request", TRAIL, "claude-code");
  const byCoordinator = await sc(agents["chief-of-staff"], "logmem_close", { item: claudeId, reason: "stale: mention with no sender" });
  assert.equal(byCoordinator.ok, true, byCoordinator.error);
  assert.equal(byCoordinator.closed_by, "agent:chief-of-staff");
  assert.equal(byCoordinator.item_id, claudeId);
  const claudeItem = await getCoordItem(store, "madez", claudeId);
  assert.equal(claudeItem.response, "declined");
  assert.equal(claudeItem.settled_by, "agent:chief-of-staff");
  const claudeRow = (await store.readLog("agent", "claude-code")).find((e) => e.payload && e.payload.item === claudeId);
  assert.equal(claudeRow.by, "agent:chief-of-staff");
  assert.equal(claudeRow.payload.closed_by, "agent:chief-of-staff");
  assert.equal(claudeRow.payload.reason, "stale: mention with no sender");
  assert.equal((await getCoordItem(store, "madez", CHIEF_ID)).response, "open");

  const byTrailId = await sc(agents["chief-of-staff"], "logmem_close", { trail: CHIEF_ID, reason: "stale: no handoff row" });
  assert.equal(byTrailId.ok, true, byTrailId.error);
  assert.equal(byTrailId.item_id, CHIEF_ID);
  assert.equal((await getCoordItem(store, "madez", CHIEF_ID)).response, "declined");
  assert.equal((await getCoordItem(store, "madez", CHIEF_ID)).settled_by, "agent:chief-of-staff");
});
