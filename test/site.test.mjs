import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryRedis } from "../src/lib/memory-redis.mjs";
import { issueCookie, isAdmin, checkPassword, mayRead } from "../src/http/admin-auth.mjs";
import { buildView, seen, decisionsFrom } from "../src/http/view.mjs";
import { runDay } from "../scripts/fieldnotes-day.mjs";

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
  const d = decisionsFrom([{ kind: "approval", trail: "a" }, { kind: "approval", trail: "b" }, { kind: "decided", origin: "a" }]);
  assert.deepEqual(d.waiting.map((x) => x.trail), ["b"]);
});
