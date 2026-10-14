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

test("site: /onboarding has every step, /probe.sh is served, and the probe pairs end to end", async (t) => {
  const { spawn, execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["scripts/dev-site.mjs", "--seed", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev-site did not start")), 15000);
    child.stdout.on("data", (d) => { if (String(d).includes("site on")) { clearTimeout(timer); resolve(); } });
    child.on("exit", (c) => reject(new Error(`dev-site exited ${c}`)));
  });
  const base = `http://localhost:${port}`;
  // The blocking execFileSync calls below can outlast the server's keep-alive
  // window, so a pooled socket may be reset: retry once on a fresh one.
  const fetchRetry = (u) => fetch(u).catch(() => fetch(u));

  const page = await fetch(`${base}/onboarding`);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const step of ["choose", "plan", "detect", "waitlist", "space", "redis", "acmi", "connect", "first", "handoff", "approver"]) {
    assert.ok(html.includes(`data-step="${step}"`), `step ${step}`);
  }
  assert.ok(html.includes("Proposed pricing, not final"));
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline scripts (CSP)");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
  assert.doesNotMatch(html, /https?:\/\/(?!logmem\.si)[a-z0-9.-]+\.[a-z]{2,}\/[^"]*\.(?:js|css|woff2?)/i, "no external scripts, styles or fonts");
  const js = await fetch(`${base}/onboarding.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /getRandomValues/);

  const sh = await fetch(`${base}/probe.sh`);
  assert.equal(sh.status, 200);
  assert.match(sh.headers.get("content-type"), /^text\/plain/);
  const script = await sh.text();
  assert.match(script, /^#!\/bin\/sh/);
  assert.ok(script.includes("LOGMEM_PAIR"));
  execFileSync("sh", ["-n", join(root, "public/probe.sh")]);

  // End to end: a fake `claude` on PATH, the real script, the real endpoint.
  const bin = mkdtempSync(join(tmpdir(), "lm-probe-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n');
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexec sleep 10\n"); // never answers: the 3 s limit must cut it off
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "codex"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, LOGMEM_PAIR: "E2E123", LOGMEM_URL: base, HOME: bin };
  const t0 = Date.now();
  const out = execFileSync("sh", [join(root, "public/probe.sh")], { env, encoding: "utf8", timeout: 20000 });
  assert.ok(Date.now() - t0 < 12000, "the hung CLI was timed out");
  assert.match(out, /found\s+claude\s+2\.1\.0 \(Claude Code\)/);
  assert.match(out, /Sent\./);
  const got = await (await fetchRetry(`${base}/api/onboarding/probe?code=E2E123`)).json();
  rmSync(join(bin, "codex")); // the timeout is proven; keep the next runs fast
  assert.equal(got.agents.find((a) => a.name === "claude").version, "2.1.0 (Claude Code)");
  assert.equal(got.agents.find((a) => a.name === "codex").version, "");
  const again = execFileSync("sh", ["-c", `sh "${join(root, "public/probe.sh")}" || echo EXIT=$?`], { env, encoding: "utf8", timeout: 20000 });
  assert.match(again, /EXIT=1/, "a used code is refused (409)");
  const quiet = execFileSync("sh", [join(root, "public/probe.sh")], { env: { ...env, LOGMEM_PAIR: "" }, encoding: "utf8", timeout: 20000 });
  assert.match(quiet, /Nothing was sent/);
});

test("site: probe.sh names a login wall (Vercel preview protection) instead of blaming the code", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createServer } = await import("node:http");
  const run = promisify(execFile); // async: the fake server lives in this process
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const [status, headers] of [[302, { location: "https://vercel.com/login" }], [401, {}]]) {
    const srv = createServer((req, res) => { res.writeHead(status, headers); res.end("<!DOCTYPE html><html>login</html>"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    t.after(() => srv.close());
    const base = `http://127.0.0.1:${srv.address().port}`;
    const { stdout } = await run("sh", ["-c", `sh "${join(root, "public/probe.sh")}" 2>&1 || echo EXIT=$?`], {
      env: { PATH: "/usr/bin:/bin", LOGMEM_PAIR: "LOGIN1", LOGMEM_URL: base, HOME: "/tmp" }, timeout: 20000,
    });
    assert.match(stdout, /asked for a login, so nothing was sent/, `status ${status}`);
    assert.match(stdout, /EXIT=1/);
    assert.doesNotMatch(stdout, /already used/);
  }
});

test("site: the onboarding probe command always fetches probe.sh from logmem.si except on local dev", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const js = readFileSync(join(root, "public/onboarding.js"), "utf8");
  const fn = js.slice(js.indexOf("var CANON"), js.indexOf("function startProbe"));
  const probeCommand = new Function("location", `${fn}; return probeCommand;`);
  assert.equal(probeCommand({ origin: "https://logmem.si" })("ABC123"), "curl -fsSL https://logmem.si/probe.sh | LOGMEM_PAIR=ABC123 sh");
  assert.equal(probeCommand({ origin: "https://logmem-abc-mad-ez-media.vercel.app" })("ABC123"), "curl -fsSL https://logmem.si/probe.sh | LOGMEM_PAIR=ABC123 sh");
  assert.equal(probeCommand({ origin: "http://localhost:4317" })("ABC123"), "curl -fsSL http://localhost:4317/probe.sh | LOGMEM_URL=http://localhost:4317 LOGMEM_PAIR=ABC123 sh");
});
