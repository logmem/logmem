// job view-ref-validation: a bad ref is refused, never read or written as an empty record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRef } from "../src/core/keys.mjs";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem } from "../src/server.mjs";

const sc = async (lm, n, a) => (await lm.callTool(n, a)).structuredContent;

test("parseRef: unknown namespaces are refused, aliases still work", () => {
  assert.throws(() => parseRef("widget:x"), /unknown namespace 'widget'/);
  assert.throws(() => parseRef("space:madez"), /unknown namespace/);
  assert.deepEqual(parseRef("thread:agent-coordination"), { ns: "channel", id: "agent-coordination" });
  assert.deepEqual(parseRef("work:issue-14"), { ns: "job", id: "issue-14" });
  assert.deepEqual(parseRef("agent:quill"), { ns: "agent", id: "quill" });
});

test("parseRef: malformed ids are refused in every namespace", () => {
  for (const bad of ["channel:bad id!", "channel: lead", "job:-x", "job:a/b", "channel:tab\there", "job:", "agent:bad id", "channel:x*"]) {
    assert.throws(() => parseRef(bad), undefined, bad);
  }
  assert.throws(() => parseRef("bad id!"), /not valid|Invalid channel id/);
  assert.throws(() => parseRef("bad id!", "job"), /job id/);
});

test("parseRef: every real id shape in use still parses", () => {
  for (const ok of ["channel:agent-coordination", "channel:fleet-ops", "job:drop1PublishQueue-20260925", "job:acmi-bridge-health-20261019", "job:v1.2_rc", "channel:team@acme", "job:a+b", "issue-14"]) {
    assert.doesNotThrow(() => parseRef(ok), ok);
  }
});

test("view and note refuse a bad ref with a clear error and write nothing", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "fleet", sessionId: "s", surface: "t", defaultAgent: "muse" });
  for (const ref of ["channel:bad id!", "widget:x"]) {
    const v = await sc(lm, "logmem_view", { ref });
    assert.equal(v.ok, false, ref);
    assert.match(v.error, /not valid|unknown namespace|Invalid channel id/);
  }
  const n = await sc(lm, "logmem_note", { where: "channel:bad id!", summary: "should not land" });
  assert.equal(n.ok, false);
  const roster = await sc(lm, "logmem_roster", { of: "channel" });
  assert.ok(!(roster.ids || []).some((id) => id.includes(" ")), "no channel with a space was created");
  const f = await sc(lm, "logmem_feed", { refs: ["widget:x", "channel:ok"] });
  assert.equal(f.ok, true, "feed reports one bad ref and keeps going");
  assert.ok((f.read_warnings || []).length >= 1);
});

// ── P0 regression: nested channel ids are real ids (codex, 2026-11-01) ──
// Four registered channels were unreadable because the plain-id colon ban
// ran over ids like "client:duane:duane-lead-pipeline". Channel ids are
// nested by design; every other namespace keeps the ban.

test("parseRef: nested channel ids parse, the four blocked channels included", () => {
  for (const ok of [
    "channel:client:duane:duane-lead-pipeline",
    "channel:client:duane:duane-requests",
    "channel:client:duane:duane-status",
    "channel:shared:team-pulse",
    "thread:client:duane:duane-lead-pipeline",
  ]) {
    const r = parseRef(ok);
    assert.equal(r.ns, "channel", ok);
    assert.ok(r.id.includes(":"), ok);
  }
});

test("parseRef: nested channel ids still refuse garbage and empty segments", () => {
  for (const bad of ["channel::x", "channel:x:", "channel:x y", "channel:x*y", "channel: lead", "channel:x\ty", "channel:undefined"]) {
    assert.throws(() => parseRef(bad), undefined, bad);
  }
  // other namespaces keep the strict no-colon rule
  assert.throws(() => parseRef("job:a:b"), /Invalid key segment/);
  assert.throws(() => parseRef("agent:a:b"));
});

test("lmKey: nested channel id builds the exact key, jobs and spaces unchanged", async () => {
  const { lmKey } = await import("../src/core/keys.mjs");
  assert.equal(lmKey("madez", "channel", "client:duane:duane-lead-pipeline", "log"), "lm:madez:channel:client:duane:duane-lead-pipeline:log");
  assert.throws(() => lmKey("madez", "job", "a:b", "log"), /Invalid key segment/);
  assert.throws(() => lmKey("madez", "channel", "client:duane::lead", "log"), /Invalid channel id/);
});

test("P0 repro: note and view round trip on a nested channel, feed reads clean", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "t", defaultAgent: "opencode" });
  const n = await sc(lm, "logmem_note", { where: "channel:client:duane:duane-lead-pipeline", kind: "progress", summary: "nested channel write works" });
  assert.equal(n.ok, true, JSON.stringify(n));
  const v = await sc(lm, "logmem_view", { ref: "channel:client:duane:duane-lead-pipeline", limit: 3 });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok((v.log || []).some((e) => (e.summary || "").includes("nested channel write")), "entry reads back");
  const f = await sc(lm, "logmem_feed", { refs: ["channel:shared:team-pulse", "channel:client:duane:duane-status"] });
  assert.equal(f.ok, true, JSON.stringify(f));
  assert.equal((f.read_warnings || []).length, 0, "no read warnings on nested channels");
});

test("compat acmi_get: thread namespace with a nested id is read, not rejected", async () => {
  const redis = createMemoryRedis();
  const lm = createLogmem({ redis, space: "madez", sessionId: "s", surface: "t", defaultAgent: "opencode", compat: true });
  const r = await sc(lm, "acmi_get", { namespace: "thread", id: "client:duane:duane-lead-pipeline" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(Object.hasOwn(r, "profile"), "record shape returned, not a rejection");
});
