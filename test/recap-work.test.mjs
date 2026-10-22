import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const call = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;
function setup(options = {}) {
  let time = 1792695000000;
  const now = () => time;
  const redis = options.redis || createMemoryRedis();
  const lm = createLogmem({ redis, space: "acme", sessionId: "recap-work", surface: "codex", now, ...options });
  return { lm, redis, advance: (ms = 1000) => { time += ms; } };
}

test("idle recap includes job and channel work and counts a fanned-out handoff once", async () => {
  const { lm, advance } = setup({ compat: true, mirror: { enabled: true, spaces: ["acme"] } });
  await call(lm, "logmem_start", { agent: "atlas" });
  advance();
  await call(lm, "logmem_assign", { job: "issue-1", title: "Issue one" });
  for (const summary of ["Drafted the fix", "Checked the fix", "Packaged the fix"]) {
    advance();
    assert.equal((await call(lm, "logmem_update", { job: "issue-1", summary })).ok, true);
  }
  advance();
  assert.equal((await call(lm, "logmem_handoff", { to: "quill", create_agent: true, where: "job:issue-1", summary: "Review the fix" })).ok, true);
  advance();
  await call(lm, "logmem_note", { where: "channel:coordination", summary: "The review is ready" });
  advance(31 * 60 * 1000);
  await lm.shifts.sweep();
  const recap = await lm.store.getRecap("atlas");
  assert.match(recap.summary, /^7 entries this shift:/);
  assert.match(recap.summary, /3 progress/);
  assert.match(recap.summary, /1 handoff/);
  assert.equal(recap.entry_count, 7);
  assert.equal(recap.coverage, "complete");
  assert.deepEqual(recap.last_entries.map(e => e.summary), ["Drafted the fix", "Checked the fix", "Packaged the fix", "Review the fix", "The review is ready"]);
});

test("manual recap filters both writer and shift and keeps its supplied notes", async () => {
  const { lm, advance } = setup();
  const started = await call(lm, "logmem_start", { agent: "atlas" });
  const shift = started.started.shift;
  const time = started.started.started_at + 1000;
  await lm.store.append("job", "real", { ts: time, by: "agent:atlas", shift, kind: "progress", trail: "real-work", summary: "Real work" });
  await lm.store.append("channel", "noise", { ts: time, by: "agent:quill", shift, kind: "memo", trail: "foreign-writer", summary: "Not Atlas" });
  await lm.store.append("channel", "noise", { ts: time, by: "agent:atlas", shift: "another-shift", kind: "memo", trail: "foreign-shift", summary: "Not this shift" });
  advance(2000);
  const out = await call(lm, "logmem_recap", { notes: "The fix is ready", end: false });
  assert.equal(out.recap.summary, "The fix is ready");
  assert.equal(out.recap.entry_count, 2);
  assert.deepEqual(out.recap.last_entries.map(e => e.summary), ["atlas (via codex) started a shift", "Real work"]);
});

test("recap exposes unreadable sources rather than claiming complete coverage", async () => {
  const memory = createMemoryRedis();
  let fail = false;
  const redis = async (...cmd) => {
    if (fail && cmd[0] === "ZRANGEBYSCORE" && cmd[1] === "lm:acme:channel:broken:log") throw new Error("fixture read failure");
    return memory(...cmd);
  };
  const { lm, advance } = setup({ redis });
  await call(lm, "logmem_start", { agent: "atlas" });
  await call(lm, "logmem_note", { where: "channel:broken", summary: "Work that cannot be read" });
  fail = true;
  advance(31 * 60 * 1000);
  await lm.shifts.sweep();
  const recap = await lm.store.getRecap("atlas");
  assert.equal(recap.coverage, "partial");
  assert.match(recap.summary, /^Partial recap:/);
  assert.ok(recap.read_errors.some(e => e.ref === "channel:broken"));
});

test("recap counts more than 200 job entries without a recent-log cutoff", async () => {
  const { lm, advance } = setup();
  const started = await call(lm, "logmem_start", { agent: "atlas" });
  for (let i = 0; i < 205; i++) await lm.store.append("job", "busy", {
    ts: started.started.started_at + i + 1, by: "agent:atlas", shift: started.started.shift,
    kind: "progress", trail: `work-${i}`, summary: `Work ${i}`,
  });
  advance(31 * 60 * 1000);
  await lm.shifts.sweep();
  const recap = await lm.store.getRecap("atlas");
  assert.equal(recap.entry_count, 206);
  assert.match(recap.summary, /^206 entries this shift:/);
});

test("recap finds a written log even when its roster index update was lost", async () => {
  const { lm, redis, advance } = setup();
  const started = await call(lm, "logmem_start", { agent: "atlas" });
  await lm.store.append("job", "orphan", { ts: started.started.started_at + 1, by: "agent:atlas", shift: started.started.shift, kind: "progress", trail: "orphan-work", summary: "Written work" });
  await redis("SREM", "lm:acme:job:list", "orphan");
  advance(31 * 60 * 1000);
  await lm.shifts.sweep();
  const recap = await lm.store.getRecap("atlas");
  assert.equal(recap.entry_count, 2);
  assert.equal(recap.coverage, "complete");
});
