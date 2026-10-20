#!/usr/bin/env node
// Local dev server for the site + web app: serves public/ and mounts the
// api/*.mjs handlers with a Vercel-like req/res. Backend: LOGMEM_REDIS_URI /
// LOGMEM_REST_*, or --seed for an in-memory Redis holding the Field Notes day.
//   node scripts/dev-site.mjs --seed [--port 4317]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 4317);

if (argv.includes("--seed")) {
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
  await call("logmem_ask", { question: "Send issue 15 to 2,184 subscribers on Tue at 9 am?", action: "Schedule the issue-15 campaign to list 'main' for Tue Oct 27, 09:00 ET.", where: "job:i15-subject" });
  await redis("HSET", "lm:fieldnotes:job:i15-draft-done:now", "stage", JSON.stringify("active"));
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
}).listen(port, () => console.log(`site on http://localhost:${port}`));
