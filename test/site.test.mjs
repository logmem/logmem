import { test } from "node:test";
import { signDecision } from "../src/core/tools.mjs";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { issueCookie, isAdmin, checkPassword, mayRead } from "../src/http/admin-auth.mjs";
import { buildView, seen, decisionsFrom } from "../src/http/view.mjs";
import { runDay } from "../scripts/fieldnotes-day.mjs";

// Test-only HMAC key for human decisions (writeDecision fails closed without one).
process.env.LOGMEM_DECIDE_SECRET ||= "test-only-decide-key-0123456789abcdef";

const ENV = { LOGMEM_ADMIN_PASSWORD: "correct horse", VERCEL_ENV: "production" };
const req = (cookie) => ({ headers: cookie ? { cookie } : {} });

test("admin auth: password check, signed cookie, expiry, tamper, production gate", () => {
  assert.equal(checkPassword("correct horse", ENV), true);
  assert.equal(checkPassword("wrong", ENV), false);
  assert.equal(checkPassword("anything", {}), false, "no password set = off");
  const c = issueCookie(ENV).split(";")[0];
  assert.equal(isAdmin(req(c), ENV), true);
  assert.equal(isAdmin(req(c.replace(/.$/, "x")), ENV), false, "tampered");
  assert.equal(isAdmin(req(c), ENV, Date.now() + 13 * 3600e3), false, "expired");
  assert.equal(isAdmin(req(c), { ...ENV, LOGMEM_ADMIN_PASSWORD: "rotated" }), false, "password rotation logs everyone out");
  assert.equal(mayRead(req(), ENV), false);
  assert.equal(mayRead(req(), { VERCEL_ENV: "production" }), false, "prod without a password never opens");
  assert.equal(mayRead(req(), { VERCEL_ENV: "preview" }), true, "preview relies on Vercel SSO");
});

test("views over a real sandbox day: overview, log, agents, job, decisions, recall; and no writes", async () => {
  const redis = createMemoryRedis();
  const day = await runDay(redis, { space: "fieldnotes" });
  const before = JSON.stringify([...redis._data.keys()].sort());
  const ov = await buildView(redis, "fieldnotes", "overview");
  assert.equal(ov.stats.agents, 4);
  assert.ok(ov.recent.length > 0);
  const log = await buildView(redis, "fieldnotes", "log");
  assert.ok(log.entries.every((e, i, a) => i === 0 || a[i - 1].ts >= e.ts), "newest first");
  const job = await buildView(redis, "fieldnotes", "job", { id: day.job });
  assert.equal(job.now.stage, "done");
  const ag = await buildView(redis, "fieldnotes", "agent", { id: "quill" });
  assert.equal(ag.recap.summary, "Issue 14 scheduled, 2 links fixed.");
  const dec = await buildView(redis, "fieldnotes", "decisions");
  assert.equal(dec.waiting.length, 0);
  assert.equal(dec.decided.length, 1);
  const rc = await buildView(redis, "fieldnotes", "recall", { q: "bank export" });
  assert.ok(rc.results.length >= 1);
  await buildView(redis, "fieldnotes", "settings");
  assert.equal(JSON.stringify([...redis._data.keys()].sort()), before, "views wrote nothing");
});

test("seen buckets and waiting decisions", () => {
  const now = Date.now();
  assert.equal(seen(now - 5 * 60e3, now).state, "active");
  assert.equal(seen(now - 60 * 60e3, now).state, "idle");
  assert.equal(seen(now - 5 * 3600e3, now).state, "offline");
  assert.equal(seen(null).state, "unknown");
  const secret = process.env.LOGMEM_DECIDE_SECRET;
  const ask = (trail, ts) => ({ kind: "approval", trail, by: "agent:q", ts, ask_digest: `h-${trail}` });
  const registry = new Map([["a", "h-a"], ["b", "h-b"], ["c", "h-c"]]);
  const signed = (origin, by) => ({ kind: "decided", origin, by, ts: 10, payload: { verdict: "approve", ask_hash: `h-${origin}`, sig: signDecision({ space: "s", origin, ask_hash: `h-${origin}`, verdict: "approve", by, ts: 10 }, secret) } });
  // z is registered but no copy matches (altered): shown waiting, never answerable.
  // y is unregistered with copies that disagree: ambiguous, not shown.
  const y = { kind: "approval", trail: "y", by: "agent:q", ts: 0, summary: "one" };
  const entries = [ask("c", 3), ask("b", 2), ask("a", 1), y, { ...y, summary: "two" }, signed("a", "human:you"), { kind: "decided", origin: "b", by: "agent:mallory" }, { kind: "decided", origin: "c", by: "human:you", payload: { verdict: "approve" } }];
  const d = decisionsFrom(entries, { secret, space: "s", registry });
  assert.deepEqual(d.waiting.map((x) => x.trail), ["c", "b"], "an agent-written or unsigned decided never closes an ask; an ambiguous unregistered ask is not shown");
  assert.deepEqual(decisionsFrom(entries, { secret, space: "other", registry }).waiting.length, 3, "a signature is bound to its space");
  assert.deepEqual(decisionsFrom(entries, { registry }).waiting.length, 3, "no secret: nothing counts as decided");
});

test("security: scorecard ignores forged checkups and coerces every field", async () => {
  const { buildScorecard, cleanDay } = await import("../api/scorecard.mjs");
  const { createStore } = await import("../src/core/store.mjs");
  const redis = createMemoryRedis();
  const s = createStore(redis, { space: "madez" });
  const evil = '<img src=x onerror=alert(1)>';
  await s.append("job", "logmem-dogfood", { kind: "checkup", by: "agent:mallory", summary: "x", payload: { date: "2026-10-11", entries: evil, pass: true } });
  await s.append("job", "logmem-dogfood", { kind: "checkup", by: "agent:logmem-check", summary: "y", payload: { date: "2026-10-12", entries: evil, agents: [evil], pass: "yes" } });
  const card = await buildScorecard(redis, "madez");
  assert.equal(card.checks, 1, "only the audit's own checkups count");
  assert.equal(card.days[0].entries, 0, "non-numeric coerced");
  assert.equal(card.days[0].pass, false, "pass must be strictly true");
  assert.equal(cleanDay({ date: "2026-10-12", unanswered_24h: "3" }, "madez").unanswered_24h, 3);
});
