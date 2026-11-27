// logmem_withdraw: the sender takes back an open Inbox item (handoff, request or seat).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "./space-context.mjs";
import { computeItemId, getCoordItem } from "../src/core/coord.mjs";

const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

async function fixture() {
  const redis = createMemoryRedis();
  let t = 1792687770000;
  const now = () => (t += 1000);
  const mk = (sid) => createLogmem({ workRules: "warn", redis, space: "madez", surface: "test", sessionId: sid, now });
  const atlas = mk("atlas-sid");
  const quill = mk("quill-sid");
  const scribe = mk("scribe-sid");
  await sc(atlas, "logmem_start", { agent: "atlas" });
  await sc(quill, "logmem_start", { agent: "quill" });
  await sc(scribe, "logmem_start", { agent: "scribe" });
  return { atlas, quill, scribe };
}

test("the sender withdraws a handoff: the item settles, Brief and sync drop it, and the recipient cannot accept it", async () => {
  const { atlas, quill } = await fixture();
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Draft issue 14", where: "job:issue-14" });
  const id = computeItemId("madez", "handoff", ho.trail, "quill");
  assert.equal((await sc(quill, "logmem_sync", {})).counts.total, 1);

  const out = await sc(atlas, "logmem_withdraw", { item: id, reason: "stale: done in PR 299" });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.item_status, "ok");
  assert.deepEqual(out.entries.length, 3, "job log, recipient log and sender log");

  const item = await getCoordItem(atlas.ctx.store, "madez", id);
  assert.equal(item.response, "declined");
  assert.equal(item.disposition, "withdrawn: stale: done in PR 299");
  assert.equal(item.settled_by, "agent:atlas");

  assert.equal((await sc(quill, "logmem_sync", {})).counts.total, 0);
  const brief = await sc(quill, "logmem_brief", {});
  assert.equal(brief.handoffs_to_me.filter((h) => h.trail === ho.trail).length, 0, "Brief no longer lists it");

  const acc = await sc(quill, "logmem_accept", { trail: ho.trail });
  assert.equal(acc.ok, false);
  assert.match(acc.error, /sender withdrew this handoff: stale: done in PR 299/);
});

test("a directed request and a seat can be withdrawn by their sender", async () => {
  const { atlas, quill, scribe } = await fixture();
  const memo = await sc(atlas, "logmem_note", { where: "channel:general", kind: "memo", summary: "Which files do you own?", to: ["quill"] });
  const huddle = await sc(atlas, "logmem_note", { where: "channel:general", kind: "huddle", summary: "Huddle on Inbox", to: ["scribe"] });
  for (const id of [...memo.items, ...huddle.items]) {
    const out = await sc(atlas, "logmem_withdraw", { item: id, reason: "answered in chat" });
    assert.equal(out.ok, true, out.error);
  }
  assert.equal((await sc(quill, "logmem_sync", {})).counts.total, 0);
  assert.equal((await sc(scribe, "logmem_sync", {})).counts.total, 0);
});

test("only the sender withdraws, a reason is required, and a settled item is refused", async () => {
  const { atlas, quill, scribe } = await fixture();
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Task", where: "job:task" });
  const id = computeItemId("madez", "handoff", ho.trail, "quill");

  const other = await sc(scribe, "logmem_withdraw", { item: id, reason: "not mine" });
  assert.equal(other.ok, false);
  assert.match(other.error, /only the sender \('atlas'\)/);

  const recipient = await sc(quill, "logmem_withdraw", { item: id, reason: "I do not want it" });
  assert.equal(recipient.ok, false, "the recipient declines with logmem_accept, not withdraw");

  const blank = await sc(atlas, "logmem_withdraw", { item: id, reason: "   " });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /reason is required/);

  const missing = await sc(atlas, "logmem_withdraw", { item: "ci_000000000000000000000000", reason: "x" });
  assert.match(missing.error, /not found/);

  await sc(quill, "logmem_accept", { trail: ho.trail });
  const late = await sc(atlas, "logmem_withdraw", { item: id, reason: "too late" });
  assert.equal(late.ok, false);
  assert.match(late.error, /already settled \(answered\)/);
});

test("logmem_note cannot forge a withdrawal that hides a handoff", async () => {
  const { atlas, quill } = await fixture();
  const ho = await sc(atlas, "logmem_handoff", { to: "quill", summary: "Task", where: "job:task" });
  const forged = await sc(quill, "logmem_note", { where: "agent:quill", kind: "feedback", summary: "gone", origin: ho.trail, payload: { withdrawn: true } });
  assert.equal(forged.ok, false);
  assert.match(forged.error, /logmem_withdraw/);
  const brief = await sc(quill, "logmem_brief", {});
  assert.equal(brief.handoffs_to_me.filter((h) => h.trail === ho.trail).length, 1);
});
