import { test } from "node:test";
import assert from "node:assert/strict";
import { timed } from "../src/http/phase-timer.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a stalled step names itself before it finishes", async () => {
  const lines = [];
  const log = (l) => lines.push(JSON.parse(l));
  const p = timed("clerk.sessions.getSession", () => sleep(60).then(() => "ok"), { env: {}, slowMs: 20, log });
  await sleep(40);
  assert.deepEqual(lines.map((l) => [l.phase, l.still_running_ms]), [["clerk.sessions.getSession", 20]]);
  assert.equal(await p, "ok");
  assert.equal(lines.at(-1).ok, true);
  assert.ok(lines.at(-1).ms >= 20);
});

test("a fast step logs nothing unless all timers are on", async () => {
  const lines = [];
  const log = (l) => lines.push(JSON.parse(l));
  await timed("viewer.authorizeSpace", async () => 1, { env: {}, slowMs: 1000, log });
  assert.equal(lines.length, 0);
  await timed("viewer.authorizeSpace", async () => 1, { env: { LOGMEM_PHASE_TIMERS: "1" }, slowMs: 1000, log });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, "info");
});

test("a failing step rethrows and records ok false", async () => {
  const lines = [];
  const log = (l) => lines.push(JSON.parse(l));
  await assert.rejects(timed("x", async () => { throw new Error("boom"); }, { env: { LOGMEM_PHASE_TIMERS: "1" }, log }), /boom/);
  assert.equal(lines[0].ok, false);
  assert.ok(!JSON.stringify(lines).includes("boom"));
});
