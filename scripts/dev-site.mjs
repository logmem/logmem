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
  const backend = await import("../src/lib/backend.mjs");
  const orig = backend.fromDescriptor;
  // dev only: route every descriptor to the seeded memory Redis
  globalThis.__lmDevRedis = redis;
  process.env.LOGMEM_REST_URL = "memory://dev";
  process.env.LOGMEM_REST_TOKEN = "dev";
  void orig;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".sh": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8" };

function wrapRes(res) {
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (o) => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  wrapRes(res);
  const url = new URL(req.url, `http://localhost:${port}`);
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
