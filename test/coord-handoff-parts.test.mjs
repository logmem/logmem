// Multi-recipient handoffs: each listed agent accepts or closes only its own part.
// A coordinator (default chief-of-staff) can close a stale part with a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "./space-context.mjs";
import { computeItemId, getCoordItem, createCoordItem } from "../src/core/coord.mjs";
import { coordinatorList, handoffAddresses, handoffRecipients } from "../src/core/tools.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

function fixture(coordinators) {
  const redis = createMemoryRedis();
  let t = 1792687770000;
  const now = () => (t += 1000);
  const opts = { workRules: "warn", redis, space: "madez", surface: "test", now };
  if (coordinators !== undefined) opts.coordinators = coordinators;
  const mk = (sid) => createLogmem({ ...opts, sessionId: sid });
  return { redis, mk, now };
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

test("handoff recipient matching treats one agent and a list as recipients", () => {
  assert.deepEqual(handoffRecipients("agent:avery"), ["avery"]);
  assert.deepEqual(handoffRecipients("avery"), ["avery"]);
  assert.deepEqual(
    handoffRecipients(["agent:chief-of-staff", "avery", "agent:claude-code"]),
    ["chief-of-staff", "avery", "claude-code"],
  );
  assert.deepEqual(handoffRecipients('["chief-of-staff","avery","claude-code"]'), ["chief-of-staff", "avery", "claude-code"]);
  assert.equal(handoffAddresses("agent:avery", "avery"), true);
  assert.equal(handoffAddresses(["agent:chief-of-staff", "agent:avery", "agent:claude-code"], "avery"), true);
  assert.equal(handoffAddresses(["agent:chief-of-staff", "agent:avery"], "claude-code"), false);
  assert.deepEqual(coordinatorList(undefined), ["chief-of-staff"]);
  assert.deepEqual(coordinatorList(""), ["chief-of-staff"]);
  assert.deepEqual(coordinatorList("ops-lead, chief-of-staff"), ["ops-lead", "chief-of-staff"]);
  assert.deepEqual(coordinatorList([]), []);
});

test("a single recipient handoff keeps its old shape and can still be accepted", async () => {
  const { mk } = fixture();
  const { polar, avery } = await roster(mk, ["polar", "avery"]);
  const ho = await sc(polar, "logmem_handoff", { to: "avery", summary: "One owner", where: "job:one" });
  assert.equal(ho.ok, true, ho.error);
  assert.equal(ho.to, "agent:avery");
  const entry = (await polar.ctx.store.readLog("agent", "avery")).find((e) => e.trail === ho.trail);
  assert.equal(entry.to, "agent:avery");
  const jobNow = await polar.ctx.store.getNow("job", "one");
  assert.equal(jobNow.owner, "agent:avery");
  assert.equal(jobNow.handoff_trail, ho.trail);
  const acc = await sc(avery, "logmem_accept", { trail: ho.trail, reason: "on it" });
  assert.equal(acc.ok, true, acc.error);
  assert.equal((await getCoordItem(polar.ctx.store, "madez", computeItemId("madez", "handoff", ho.trail, "avery"))).response, "answered");
});

test("each recipient of a multi-recipient handoff can accept its own part", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["polar", "chief-of-staff", "avery", "claude-code", "scribe"]);
  const ho = await sc(agents.polar, "logmem_handoff", {
    to: ["chief-of-staff", "avery", "claude-code"],
    summary: "Review the fleet note",
    where: "job:fleet-note",
  });
  assert.equal(ho.ok, true, ho.error);
  assert.deepEqual(ho.to, ["agent:chief-of-staff", "agent:avery", "agent:claude-code"]);
  const stored = (await agents.polar.ctx.store.readLog("agent", "avery")).find((e) => e.kind === "handoff" && e.trail === ho.trail);
  assert.deepEqual(stored.to, ["agent:chief-of-staff", "agent:avery", "agent:claude-code"]);

  const item = (who) => getCoordItem(agents.polar.ctx.store, "madez", computeItemId("madez", "handoff", ho.trail, who));
  for (const who of ["chief-of-staff", "avery", "claude-code"]) {
    assert.equal((await item(who)).response, "open", who);
    const brief = await sc(agents[who], "logmem_brief", {});
    assert.equal(brief.handoffs_to_me.filter((h) => h.trail === ho.trail).length, 1, who);
  }

  const stranger = await sc(agents.scribe, "logmem_accept", { trail: ho.trail });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /no handoff with trail '.*' was passed to scribe/);

  const acc = await sc(agents.avery, "logmem_accept", { trail: ho.trail, reason: "on it" });
  assert.equal(acc.ok, true, acc.error);
  assert.equal((await item("avery")).response, "answered");
  assert.equal((await item("chief-of-staff")).response, "open");
  assert.equal((await item("claude-code")).response, "open");
  assert.equal((await sc(agents.avery, "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 0);
  assert.equal((await sc(agents["chief-of-staff"], "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 1);

  const acc2 = await sc(agents["chief-of-staff"], "logmem_accept", { trail: ho.trail });
  assert.equal(acc2.ok, true, acc2.error);
  assert.equal((await item("chief-of-staff")).response, "answered");
  assert.equal((await item("claude-code")).response, "open");
  const still = await sc(agents["claude-code"], "logmem_accept", { trail: ho.trail, reason: "taking the last part" });
  assert.equal(still.ok, true, still.error);
  assert.equal((await item("claude-code")).response, "answered");
});

test("a handoff already stored with an array of recipients matches each listed agent", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["polar", "chief-of-staff", "avery", "claude-code", "scribe"]);
  const store = agents.polar.ctx.store;
  const trail = "planted-array-handoff";
  const to = ["agent:chief-of-staff", "agent:avery", "agent:claude-code"];
  const entry = { ts: 1792687770000, kind: "handoff", by: "agent:polar", to, trail, summary: "Planted list", job: "job:planted" };
  await store.append("job", "planted", entry);
  for (const who of ["chief-of-staff", "avery", "claude-code"]) {
    await store.append("agent", who, entry);
    await createCoordItem(store, {
      space: "madez", type: "handoff", requestTrail: trail, from: "agent:polar", to: `agent:${who}`,
      where: "job:planted", summary: "Planted list", createdAt: entry.ts,
    });
  }
  const stranger = await sc(agents.scribe, "logmem_accept", { trail });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /was passed to scribe/);
  assert.equal((await sc(agents.avery, "logmem_accept", { trail, reason: "picked up" })).ok, true);
  assert.equal((await getCoordItem(store, "madez", computeItemId("madez", "handoff", trail, "avery"))).response, "answered");
  assert.equal((await getCoordItem(store, "madez", computeItemId("madez", "handoff", trail, "claude-code"))).response, "open");
  assert.equal((await sc(agents["claude-code"], "logmem_close", { trail, reason: "stale: already shipped" })).ok, true);
  assert.equal((await getCoordItem(store, "madez", computeItemId("madez", "handoff", trail, "claude-code"))).response, "declined");
  assert.equal((await getCoordItem(store, "madez", computeItemId("madez", "handoff", trail, "chief-of-staff"))).response, "open");
});

test("each recipient can close its own part, and a non-recipient cannot", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["polar", "avery", "claude-code", "scribe"]);
  const ho = await sc(agents.polar, "logmem_handoff", {
    to: ["avery", "claude-code"],
    summary: "Split the note",
    where: "job:split",
  });
  const store = agents.polar.ctx.store;
  const item = (who) => getCoordItem(store, "madez", computeItemId("madez", "handoff", ho.trail, who));

  const otherPart = await sc(agents.avery, "logmem_close", { trail: ho.trail, to: "claude-code", reason: "I will close theirs" });
  assert.equal(otherPart.ok, false);
  assert.match(otherPart.error, /forbidden/);
  assert.equal((await item("claude-code")).response, "open");

  const stranger = await sc(agents.scribe, "logmem_close", { trail: ho.trail, reason: "not mine" });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /forbidden/);

  const named = await sc(agents.scribe, "logmem_close", { trail: ho.trail, to: "avery", reason: "not mine either" });
  assert.equal(named.ok, false);
  assert.match(named.error, /forbidden/);

  const closed = await sc(agents.avery, "logmem_close", { trail: ho.trail, reason: "stale: already shipped" });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.closed_by, "agent:avery");
  const averyItem = await item("avery");
  assert.equal(averyItem.response, "declined");
  assert.equal(averyItem.settled_by, "agent:avery");
  assert.equal(averyItem.disposition, "closed: stale: already shipped");
  assert.equal((await item("claude-code")).response, "open");

  const row = (await store.readLog("agent", "avery")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.by, "agent:avery");
  assert.equal(row.payload.closed_by, "agent:avery");
  assert.equal(row.payload.reason, "stale: already shipped");
  assert.equal(row.origin, ho.trail);
  const onJob = (await store.readLog("job", "split")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(onJob.by, "agent:avery");
  assert.equal((await sc(agents.avery, "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 0);
  assert.equal((await sc(agents["claude-code"], "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 1);

  const rest = await sc(agents["claude-code"], "logmem_close", { trail: ho.trail, reason: "answered in chat" });
  assert.equal(rest.ok, true, rest.error);
  assert.equal((await item("claude-code")).response, "declined");
});

test("a recipient can close a part they already answered", async () => {
  const { mk } = fixture();
  const { polar, avery } = await roster(mk, ["polar", "avery"]);
  const ho = await sc(polar, "logmem_handoff", { to: "avery", summary: "Done already", where: "job:done-part" });
  assert.equal((await sc(avery, "logmem_accept", { trail: ho.trail })).ok, true);
  const closed = await sc(avery, "logmem_close", { trail: ho.trail, reason: "already answered in the job log" });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.item_status, "already_settled");
  const row = (await polar.ctx.store.readLog("agent", "avery")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.payload.reason, "already answered in the job log");
  assert.equal(row.payload.closed_by, "agent:avery");
  assert.equal((await getCoordItem(polar.ctx.store, "madez", computeItemId("madez", "handoff", ho.trail, "avery"))).response, "answered");
});

test("close requires a reason, and a coordinator can close a stuck handoff", async () => {
  const { mk } = fixture();
  const agents = await roster(mk, ["balto", "design-agency", "chief-of-staff", "scribe"]);
  const ho = await sc(agents.balto, "logmem_handoff", { to: "design-agency", summary: "Draw the mark", where: "job:mark" });
  const store = agents.balto.ctx.store;
  const id = computeItemId("madez", "handoff", ho.trail, "design-agency");

  for (const reason of [undefined, "", "   "]) {
    const blank = await sc(agents["chief-of-staff"], "logmem_close", { trail: ho.trail, to: "design-agency", reason });
    assert.equal(blank.ok, false);
    assert.match(blank.error, /reason is required/);
  }
  assert.equal((await getCoordItem(store, "madez", id)).response, "open");

  const denied = await sc(agents.scribe, "logmem_close", { trail: ho.trail, to: "design-agency", reason: "I am not the coordinator" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /forbidden/);

  const closed = await sc(agents["chief-of-staff"], "logmem_close", {
    trail: ho.trail,
    to: "design-agency",
    reason: "stale: design-agency has no key",
  });
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.closed_by, "agent:chief-of-staff");
  const item = await getCoordItem(store, "madez", id);
  assert.equal(item.response, "declined");
  assert.equal(item.settled_by, "agent:chief-of-staff");
  assert.equal(item.disposition, "closed: stale: design-agency has no key");

  const row = (await store.readLog("agent", "design-agency")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.by, "agent:chief-of-staff");
  assert.equal(row.payload.closed_by, "agent:chief-of-staff");
  assert.equal(row.payload.reason, "stale: design-agency has no key");
  const onJob = (await store.readLog("job", "mark")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(onJob.payload.closed_by, "agent:chief-of-staff");
  assert.equal((await sc(agents["design-agency"], "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 0);
  const again = await sc(agents["design-agency"], "logmem_accept", { trail: ho.trail });
  assert.equal(again.ok, false);
  assert.match(again.error, /closed by chief-of-staff/);
});

test("the coordinator list is explicit and a random agent stays forbidden", async () => {
  const prev = process.env.LOGMEM_COORDINATORS;
  delete process.env.LOGMEM_COORDINATORS;
  try {
    const { mk } = fixture();
    const bare = mk("default-coord");
    assert.deepEqual(bare.ctx.coordinators, ["chief-of-staff"]);
  } finally {
    if (prev === undefined) delete process.env.LOGMEM_COORDINATORS;
    else process.env.LOGMEM_COORDINATORS = prev;
  }

  const { mk } = fixture(["ops-lead"]);
  const agents = await roster(mk, ["balto", "design-agency", "chief-of-staff", "ops-lead", "scribe"]);
  const ho = await sc(agents.balto, "logmem_handoff", { to: "design-agency", summary: "Hold the file", where: "job:file" });
  const chief = await sc(agents["chief-of-staff"], "logmem_close", { trail: ho.trail, to: "design-agency", reason: "not on the list" });
  assert.equal(chief.ok, false);
  assert.match(chief.error, /forbidden/);
  const random = await sc(agents.scribe, "logmem_close", { trail: ho.trail, reason: "no" });
  assert.equal(random.ok, false);
  assert.match(random.error, /forbidden/);
  const ops = await sc(agents["ops-lead"], "logmem_close", { trail: ho.trail, to: "design-agency", reason: "stale: ops closed it" });
  assert.equal(ops.ok, true, ops.error);
  assert.equal(ops.closed_by, "agent:ops-lead");
  const row = (await agents.balto.ctx.store.readLog("job", "file")).find((e) => e.payload && e.payload.closed === true);
  assert.equal(row.payload.closed_by, "agent:ops-lead");
  assert.equal(row.payload.reason, "stale: ops closed it");
});

test("withdraw is sender-only: a non-sender is forbidden and the sender can still withdraw", async () => {
  const { mk } = fixture();
  const { atlas, quill, scribe } = await roster(mk, ["atlas", "quill", "scribe"]);
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Task", where: "job:task" });
  const id = computeItemId("madez", "handoff", ho.trail, "quill");

  const other = await sc(scribe, "logmem_withdraw", { item: id, reason: "not mine" });
  assert.equal(other.ok, false);
  assert.match(other.error, /only the sender \('atlas'\)/);
  const recipient = await sc(quill, "logmem_withdraw", { item: id, reason: "I do not want it" });
  assert.equal(recipient.ok, false);
  assert.match(recipient.error, /only the sender \('atlas'\)/);
  assert.equal((await getCoordItem(atlas.ctx.store, "madez", id)).response, "open");

  const out = await sc(atlas, "logmem_withdraw", { item: id, reason: "stale: done in PR 299" });
  assert.equal(out.ok, true, out.error);
  const item = await getCoordItem(atlas.ctx.store, "madez", id);
  assert.equal(item.response, "declined");
  assert.equal(item.settled_by, "agent:atlas");
  assert.equal(item.disposition, "withdrawn: stale: done in PR 299");
  const acc = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(acc.ok, false);
  assert.match(acc.error, /sender withdrew this handoff/);
});

test("logmem_note cannot forge a close that hides a handoff", async () => {
  const { mk } = fixture();
  const { polar, avery } = await roster(mk, ["polar", "avery"]);
  const ho = await sc(polar, "logmem_handoff", { to: "avery", summary: "Stay open", where: "job:stay" });
  const forged = await sc(avery, "logmem_note", {
    where: "agent:avery", kind: "feedback", summary: "gone", origin: ho.trail, payload: { closed: true, reason: "forged" },
  });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /logmem_close/);
  assert.equal((await sc(avery, "logmem_brief", {})).handoffs_to_me.filter((h) => h.trail === ho.trail).length, 1);
});
