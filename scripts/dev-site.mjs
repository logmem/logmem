#!/usr/bin/env node
// Local dev server for the site + web app: serves public/ and mounts the
// api/*.mjs handlers with a Vercel-like req/res. Backend: LOGMEM_REDIS_URI /
// LOGMEM_REST_*, or --seed for an in-memory Redis holding the Field Notes day.
//   node scripts/dev-site.mjs --seed [--port 4317]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { issueCookie } from "../src/http/admin-auth.mjs";

const here = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 4317);

if (argv.includes("--business-demos")) {
  // Deliberately isolated local examples. Never connect this flag to a real backend.
  if (process.env.VERCEL_ENV === "production") throw new Error("Business demos are local only");
  const { createMemoryRedis } = await import("../src/lib/memory-redis.mjs");
  const { seedBusinessDemos, BUSINESS_DEMOS } = await import("./seed-business-demos.mjs");
  const redis = createMemoryRedis();
  await seedBusinessDemos(redis);
  globalThis.__lmDevRedis = redis;
  delete process.env.LOGMEM_REDIS_URI;
  delete process.env.ACMI_REDIS_URI;
  process.env.LOGMEM_REST_URL = "memory://business-demos";
  process.env.LOGMEM_REST_TOKEN = "local-synthetic-demo";
  process.env.LOGMEM_VIEW_SPACES = BUSINESS_DEMOS.map(d => d.id).join(",");
  // A disposable person session for this loopback-only, in-memory fixture.
  // No production password or decision key is reused or exposed to the browser.
  process.env.LOGMEM_ADMIN_PASSWORD = randomBytes(32).toString("hex");
  process.env.LOGMEM_ADMIN_SECRET = randomBytes(32).toString("hex");
  process.env.LOGMEM_DECIDE_SECRET = randomBytes(32).toString("hex");
  process.env.LOGMEM_ADMIN_ID = "admin";
}

if (argv.includes("--seed") && !argv.includes("--business-demos")) {
  const { createMemoryRedis } = await import("../src/lib/memory-redis.mjs");
  const { runDay } = await import("../scripts/fieldnotes-day.mjs");
  const redis = createMemoryRedis();
  await runDay(redis, { space: "fieldnotes" });
  // Live app demo (dev only): a plan with milestones, a blocked job of each kind, and a task and a decision for the person.
  const { createLogmem } = await import("../src/server.mjs");
  const lm = createLogmem({ redis, space: "fieldnotes", sessionId: "dev-seed", surface: "dev", defaultAgent: "quill" });
  const call = (n, a) => lm.callTool(n, a);
  await call("logmem_plan", { action: "create", plan: "issue-15", title: "Field Notes issue 15", desc: "Ships Tue Oct 27." });
  await call("logmem_assign", { job: "i15-draft-done", title: "Draft locked", details: { plan: "issue-15", milestone: true, date: "2026-10-23", criteria: "Every section drafted and fact-checked." } });
  await call("logmem_assign", { job: "i15-send", title: "Issue 15 sent", details: { plan: "issue-15", milestone: true, date: "2026-10-27", criteria: "Sent to the full list, no bounces over 1%." } });
  for (const [job, title, track] of [["i15-lead", "Lead story: the river cleanup", "Writing"], ["i15-photos", "Photo set from the cleanup", "Design"], ["i15-sponsor", "Sponsor slot copy", "Revenue"], ["i15-list", "Clean the subscriber list", "Send"], ["i15-subject", "Subject line test", "Send"]]) {
    await call("logmem_assign", { job, title, details: { plan: "issue-15", track, milestone: "i15-draft-done", due: "2026-10-23" } });
  }
  await call("logmem_stage", { job: "i15-lead", stage: "done", note: "Draft in the doc, 1,240 words." });
  await call("logmem_stage", { job: "i15-subject", stage: "active" });
  await call("logmem_stage", { job: "i15-photos", stage: "blocked", blocked_on: { type: "agent", ref: "atlas", note: "Atlas has the raw photos and has not sent them." } });
  await call("logmem_stage", { job: "i15-list", stage: "blocked", blocked_on: { type: "external", note: "The email provider's import is down." } });
  await call("logmem_handoff", { to: "human:admin", where: "job:i15-sponsor", summary: "Approve the sponsor's logo and link in the newsletter tool", walkthrough: { time: "3 min", place: "Newsletter tool", done_when: "The sponsor block shows the new logo.", reply: "[handoff @quill] Sponsor block is approved.", steps: [{ title: "Open the issue 15 draft", detail: "Drafts, then Issue 15." }, { title: "Check the sponsor logo", detail: "It should be the green version." }, { title: "Check the link", cmd: "https://example.com/sponsor" }] } });
  // A walkthrough with where to go and what you should see (the walkthrough player).
  await call("logmem_handoff", { to: "human:admin", where: "job:i15-subject", summary: "Set up the subject line test in the newsletter tool", walkthrough: { done_when: "Both subject lines show in the test panel.", reply: "[handoff @quill] Subject test is set: A and B at 50/50.", steps: [{ title: "Open the newsletter tool", go: "https://example.com/newsletter", see: "The Issue 15 draft in your list" }, { title: "Turn on the A/B test", go: "Issue 15 › Settings › Subject test", detail: "Pick a 50/50 split on 20% of the list.", see: "A green 'Test on' tag next to the subject" }, { title: "Paste subject B", cmd: "The river came back. So did 400 volunteers.", see: "Subject A and Subject B side by side" }] } });
  await call("logmem_ask", { question: "Send issue 15 to 2,184 subscribers on Tue at 9 am?", action: "Schedule the issue-15 campaign to list 'main' for Tue Oct 27, 09:00 ET.", where: "job:i15-subject" });
  await redis("HSET", "lm:fieldnotes:job:i15-draft-done:now", "stage", JSON.stringify("active"));
  // Lanes demo: issue 15 is the P0 lane, a podcast plan is active, the shop is parked, and one job parks inside the P0 lane.
  await call("logmem_plan", { action: "lane", plan: "issue-15", status: "p0", why: "Ships Tue Oct 27", owner: "quill" });
  await call("logmem_plan", { action: "create", plan: "podcast", title: "Field Notes podcast pilot" });
  await call("logmem_plan", { action: "lane", plan: "podcast", status: "active", owner: "relay" });
  await call("logmem_assign", { job: "pod-script", title: "Pilot episode script", details: { plan: "podcast", track: "Writing" } });
  await call("logmem_stage", { job: "pod-script", stage: "active" });
  await call("logmem_plan", { action: "create", plan: "shop", title: "Field Notes print shop" });
  await call("logmem_plan", { action: "lane", plan: "shop", status: "parked", why: "Waits for 1,000 subscribers", until: "after issue 20" });
  await call("logmem_assign", { job: "i15-ads", title: "Paid ad test", details: { plan: "issue-15", track: "Revenue" } });
  await call("logmem_stage", { job: "i15-ads", stage: "blocked", blocked_on: { type: "external", note: "Parked until the sponsor renews", parked: true, until: "Nov 1" } });
  // Hardening demo: a second, reversible decision (for batch answers) and a huddle with one reply (for the round table).
  await call("logmem_ask", { question: "Use the green logo variant for issue 15?", action: "Set the issue-15 header logo to logo-green.svg.", where: "job:i15-photos", reversible: true });
  await call("logmem_note", { where: "channel:field-notes", kind: "huddle", trail: "huddleIssue15Plan-1", summary: "[huddle @atlas @relay] quill: issue 15 ships Tue. Can we lock the draft by Fri? Reply with yes or the risk." });
  const atlas = createLogmem({ redis, space: "fieldnotes", sessionId: "dev-seed-atlas", surface: "dev", defaultAgent: "atlas" });
  await atlas.callTool("logmem_note", { where: "channel:field-notes", kind: "memo", origin: "huddleIssue15Plan-1", summary: "atlas: yes, photos land Thu." });
  const backend = await import("../src/lib/backend.mjs");
  const orig = backend.fromDescriptor;
  // dev only: route every descriptor to the seeded memory Redis
  globalThis.__lmDevRedis = redis;
  process.env.LOGMEM_REST_URL = "memory://dev";
  process.env.LOGMEM_REST_TOKEN = "dev";
  void orig;
}

const REWRITES = JSON.parse(await readFile(join(here, "vercel.json"), "utf8")).rewrites.filter((r) => !r.source.includes(":") && !r.source.includes("("));
const TYPES = { ".webmanifest": "application/manifest+json", ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".sh": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8" };

function wrapRes(res) {
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  wrapRes(res);
  let url = new URL(req.url, `http://localhost:${port}`);
  // Apply vercel.json's exact-path rewrites, as Vercel does (e.g. /api/pulse -> /api/work?op=pulse).
  const rw = REWRITES.find((r) => r.source === url.pathname);
  if (rw) {
    const dest = new URL(rw.destination, url);
    for (const [k, v] of url.searchParams) if (!dest.searchParams.has(k)) dest.searchParams.set(k, v);
    url = dest;
    req.url = dest.pathname + dest.search;
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      if (argv.includes("--business-demos")) req.headers.cookie = issueCookie().split(";")[0];
      const name = url.pathname.slice(5).replace(/\/$/, "");
      const mod = await import(join(here, "api", `${name}.mjs`));
      req.query = Object.fromEntries(url.searchParams);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      return await mod.default(req, res);
    }
    let p = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!extname(p)) p += ".html";
    const file = normalize(join(here, "public", p));
    if (!file.startsWith(join(here, "public"))) return res.status(403).end();
    const body = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.end(body);
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[dev-site]", e);
    res.status(e.code === "ENOENT" ? 404 : 500).end(e.code === "ENOENT" ? "not found" : "internal error");
  }
}).listen(port, argv.includes("--business-demos") ? "127.0.0.1" : undefined, () => console.log(`site on http://localhost:${port}`));
