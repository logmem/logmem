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
  assert.throws(() => parseRef("bad id!"), /not valid/);
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
    assert.match(v.error, /not valid|unknown namespace/);
  }
  const n = await sc(lm, "logmem_note", { where: "channel:bad id!", summary: "should not land" });
  assert.equal(n.ok, false);
  const roster = await sc(lm, "logmem_roster", { of: "channel" });
  assert.ok(!(roster.ids || []).some((id) => id.includes(" ")), "no channel with a space was created");
  const f = await sc(lm, "logmem_feed", { refs: ["widget:x", "channel:ok"] });
  assert.equal(f.ok, true, "feed reports one bad ref and keeps going");
  assert.ok((f.read_warnings || []).length >= 1);
});
