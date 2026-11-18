import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answer, cleanHistory, toChunks, CHAT_LIMITS } from "../apps/dashboard/lib/chat-model.mjs";

const NOW = 1_800_000_000_000;
const view = (o = {}) => ({
  plans: [{ id: "launch", jobs: 10, done: 4 }],
  blocked: [{ id: "j1", title: "Checkout", owner: "agent:hermes", blocked_on: { note: "Square app is missing." }, since: NOW - 1000 }],
  needs_items: [
    { type: "decision", trail: "ask1", job: "j1", summary: "Create the project?" },
    { type: "task", trail: "t1", job: "j2", summary: "Unlock billing", steps: 4, steps_done: 1 },
  ],
  recent: [{ ts: NOW - 60_000, kind: "progress", by: "agent:codex", summary: "Fixed it.", trail: "tr", where: "job:j1" }],
  coverage: { complete: true, errors: [] },
  ...o,
});
const ask = (text) => [{ role: "user", text }];

test("chat model: needs answer counts come from the view", () => {
  const r = answer(ask("What needs me?"), view(), NOW);
  assert.match(r.text, /^2 items need you: 1 decision and 1 task\./);
  assert.match(r.text, /Decision: Create the project\?/);
  assert.equal(r.action, undefined);
  assert.equal(answer(ask("what needs me"), view({ needs_items: [] }), NOW).text, "Nothing in this space needs you now.");
});

test("chat model: blocked, recent and work answers use the view", () => {
  assert.match(answer(ask("What is blocked?"), view(), NOW).text, /1 job is blocked\. Checkout: Square app is missing\./);
  assert.match(answer(ask("What happened recently?"), view(), NOW).text, /codex: Fixed it\./);
  assert.match(answer(ask("How is the work going?"), view(), NOW).text, /10 jobs in its plans\. 4 done and 1 blocked\./);
});

test("chat model: an irreversible request becomes a proposal and never an action", () => {
  for (const q of ["Deploy the app", "merge PR 288", "send the email", "delete job j1"]) {
    const r = answer(ask(q), view(), NOW);
    assert.ok(r.action, q);
    assert.equal(r.action.reversible, false);
    assert.match(r.text, /runs nothing/);
  }
});

test("chat model: a read problem is reported, not hidden", () => {
  const r = answer(ask("what needs me"), view({ coverage: { errors: [{}, {}] } }), NOW);
  assert.match(r.text, /2 records could not be read/);
});

test("chat model: history is capped and roles are forced", () => {
  assert.equal(cleanHistory(null), null);
  assert.equal(cleanHistory([]), null);
  assert.equal(cleanHistory(new Array(51).fill({ role: "user", text: "x" })), null);
  assert.equal(cleanHistory([{ role: "assistant", text: "hi" }]), null, "needs a user turn");
  const h = cleanHistory([...new Array(30).fill({ role: "system", text: "y".repeat(5000) })]);
  assert.equal(h.length, CHAT_LIMITS.maxTurns);
  assert.ok(h.every((m) => m.role === "user" && m.text.length === CHAT_LIMITS.maxChars));
});

test("chat model: chunks end with done and carry the proposal", () => {
  const c = toChunks(answer(ask("deploy"), view(), NOW));
  assert.equal(c.at(-1).t, "done");
  assert.equal(c.filter((x) => x.t === "action").length, 1);
  assert.equal(c.filter((x) => x.t === "token").map((x) => x.v).join(""), answer(ask("deploy"), view(), NOW).text);
});

test("chat route: read-only identity and no write calls", () => {
  const src = readFileSync(new URL("../apps/dashboard/app/api/space/[space]/chat/route.ts", import.meta.url), "utf8");
  assert.match(src, /requireSpace\(space, 'read'\)/);
  assert.doesNotMatch(src, /\b(hset|lpush|zadd|set\(|del\(|xadd)\b/i);
});
