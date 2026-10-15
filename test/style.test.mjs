import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { createLogmem, INSTRUCTIONS } from "../src/server.mjs";
import { checkStyle, styleFor, STYLE_STANDARD } from "../src/core/style.mjs";

const rules = (t) => checkStyle(t).map((w) => w.rule);
const sc = async (lm, name, args) => (await lm.callTool(name, args)).structuredContent;

test("style: clean plain English has no warnings", () => {
  assert.deepEqual(rules("Merged #32. Next: release #35."), []);
  assert.deepEqual(rules("LogMem is shared memory for agents."), []); // participle as adjective
  assert.deepEqual(rules("atlas fixed the checkout redirect. quill tests it next."), []);
});

test("style: each rule fires", () => {
  assert.deepEqual(rules("The PR was merged."), ["passive_voice"]);
  assert.deepEqual(rules("The fix is sent to Mikey for review."), ["passive_voice"]);
  assert.deepEqual(rules("Each connection is bound to one space."), ["passive_voice"]);
  assert.ok(rules("We should ship it.").includes("weak_modal"));
  assert.ok(rules("Let's delve into the logs.").includes("filler"));
  assert.ok(rules("Done — next is review.").includes("dash"));
  assert.ok(rules("Done; next is review.").includes("semicolon"));
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") + ".";
  assert.deepEqual(rules(long), ["long_sentence"]);
});

test("style: code spans and lists are exempt", () => {
  assert.deepEqual(rules("Ran `it should — work; maybe`."), []);
  assert.deepEqual(rules("Kinds: started, ping, recap, joined, setup, handoff, accepted, assigned, progress, done, shared, research, checkup, feedback, approval, pivot, stuck, alert, memo, huddle, problem, fix."), []);
});

test("style: at most 5 warnings, and styleFor is null when clean", () => {
  assert.ok(checkStyle("We should maybe delve — it was merged; leverage it, it could help, it might, it would.").length <= 5);
  assert.equal(styleFor("Merged #32."), null);
  assert.equal(styleFor("It was merged.").standard, STYLE_STANDARD);
  assert.deepEqual(checkStyle(""), []);
  assert.deepEqual(checkStyle(null), []);
});

test("style: the server instructions obey the standard and stay under 2000 chars", () => {
  assert.ok(INSTRUCTIONS.length < 2000, `${INSTRUCTIONS.length} chars`);
  assert.match(INSTRUCTIONS, /ASD-STE100/);
  assert.deepEqual(checkStyle(INSTRUCTIONS), []);
});

test("style: a write returns warnings and is never blocked; a clean write carries no style", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "fieldnotes", surface: "codex", sessionId: "s1" });
  await sc(lm, "logmem_start", { agent: "atlas" });
  const messy = await sc(lm, "logmem_note", { where: "channel:ops", summary: "The deploy was finished and we should probably check it — maybe." });
  assert.equal(messy.ok, true, "the write lands");
  assert.equal(messy.style.standard, "logmem-plain-v1");
  assert.deepEqual(messy.style.warnings.map((w) => w.rule).sort(), ["dash", "passive_voice", "weak_modal"]);
  const clean = await sc(lm, "logmem_note", { where: "channel:ops", summary: "Deployed 3a8097f. Health check passes." });
  assert.equal(clean.ok, true);
  assert.equal(clean.style, undefined);
  const hand = await sc(lm, "logmem_handoff", { to: "atlas", where: "job:x", summary: "It could be reviewed by quill.", create_agent: true });
  assert.ok(hand.style.warnings.some((w) => w.rule === "weak_modal"), "handoff results are checked too");
});

test("style: feed and recall do not check text from other agents", async () => {
  const lm = createLogmem({ redis: createMemoryRedis(), space: "fieldnotes", surface: "codex", sessionId: "s-read" });
  await sc(lm, "logmem_start", { agent: "atlas" });
  const summary = "The deploy was finished and we should probably check it — maybe.";
  const wrote = await sc(lm, "logmem_note", { where: "channel:ops", summary });
  assert.equal(wrote.style.standard, "logmem-plain-v1", "the write is checked");
  const feed = await sc(lm, "logmem_feed", { refs: ["channel:ops"] });
  assert.equal(feed.entries[0].summary, summary);
  assert.equal(feed.style, undefined, "a feed holds text the reader did not write");
  const recall = await sc(lm, "logmem_recall", { query: "deploy finished" });
  assert.ok(recall.results.some((r) => r.summary === summary), "recall finds the entry");
  assert.equal(recall.style, undefined, "recall holds text the reader did not write");
});
