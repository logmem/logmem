// serve.mjs — the self-host bundle's HTTP entry (job personal-selfhost-bundle).
//
// One node process serves the same surface as logmem.si, with no Vercel:
//   1. redirects from vercel.json        (llm.txt -> llms.txt)
//   2. static files from public/         (exact, then cleanUrls .html, then dir index)
//   3. api/** handlers                   (the Vercel-style req/res contract)
//   4. rewrites from vercel.json         (/mcp, /sign-in, /api/pulse, well-known)
//   5. 404
//
// Security headers and CSP come from vercel.json, applied per request path
// before the handler runs, so the browser sees the same policy as production.
//
// Crons are NOT scheduled here (production runs them on Vercel's clock). Run
// them by hand or from a host scheduler — see selfhost/README.md.
//
// No imports outside node:* and the repo's own files: this file is copied
// into the Docker image as-is.

import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const SELF_DIR = dirname(fileURLToPath(import.meta.url)); // .../selfhost
const ROOT = dirname(SELF_DIR);                            // repo root
const PUBLIC_DIR = join(ROOT, "public");
const API_DIR = join(ROOT, "api");

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3899;
const MAX_BODY = 1024 * 1024; // handlers enforce their own tighter caps

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".xml": "application/xml",
  ".webmanifest": "application/manifest+json", ".zip": "application/zip",
  ".woff": "font/woff", ".woff2": "font/woff2",
};

// ─── vercel.json matching ───────────────────────────────────────────────

/** Match a vercel.json source pattern against a pathname.
 *  Returns the match array, or null. Three classes:
 *    grouped  — contains "(", used as a raw regex (the production patterns)
 *    param'd  — contains ":name", literals escaped, params become groups
 *    exact    — plain string equality
 */
export function matchSource(src, pathname) {
  if (src.includes("(")) {
    return pathname.match(new RegExp(`^${src}$`));
  }
  if (src.includes(":")) {
    let out = "";
    const tok = /:([A-Za-z0-9_]+)(\*)?/y;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === ":") {
        tok.lastIndex = i;
        const m = tok.exec(src);
        if (m) { out += `(?<${m[1]}>${m[2] ? ".*" : "[^/]+"})`; i = tok.lastIndex - 1; continue; }
      }
      out += src[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return pathname.match(new RegExp(`^${out}$`));
  }
  return src === pathname ? [pathname] : null;
}

function sourceMatches(src, pathname) {
  return matchSource(src, pathname) !== null;
}

/** Apply every vercel.json header rule that matches this request path. */
export function headersFor(pathname, rules) {
  const out = {};
  for (const rule of rules || []) {
    if (!sourceMatches(rule.source, pathname)) continue;
    for (const h of rule.headers || []) out[h.key] = h.value;
  }
  return out;
}

/** Resolve a rewrite for this path, or null. Params (:name, :path*) are
 *  substituted into the destination and merged into the query. */
export function rewriteFor(pathname, query, rules) {
  for (const rule of rules || []) {
    const m = matchSource(rule.source, pathname);
    if (!m) continue;
    let dest = rule.destination;
    // Named params in the source (:path*, :slug) bind captures for the destination.
    const names = [...rule.source.matchAll(/:([A-Za-z0-9_]+)\*?/g)].map((x) => x[1]);
    for (const name of names) {
      const bound = m.groups?.[name] ?? "";
      dest = dest.replaceAll(`:${name}*`, bound).replaceAll(`:${name}`, bound);
    }
    const [path, search] = dest.split("?", 2);
    const merged = { ...query };
    if (search) for (const [k, v] of new URLSearchParams(search)) merged[k] = v;
    return { path, query: merged };
  }
  return null;
}

// ─── api routes ─────────────────────────────────────────────────────────

/** Every file under api/ as { path, file, re, params }, skipping _private dirs. */
export function buildApiRoutes(apiDir = API_DIR) {
  const routes = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("_")) continue; // api/oauth/_lib is not a route
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${name}`);
      } else if (name.endsWith(".mjs")) {
        const base = name.slice(0, -4) === "index" ? "" : `/${name.slice(0, -4)}`;
        const path = `${prefix}${base}`;
        const params = [];
        const src = path.split("/").map((seg) => {
          const dyn = /^\[(.+)\]$/.exec(seg);
          if (dyn) { params.push(dyn[1]); return `(?<${dyn[1]}>[^/]+)`; } // join("/") adds the separator
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }).join("/");
        routes.push({ path, file: full, re: new RegExp(`^${src}/?$`), params });
      }
    }
  };
  walk(apiDir, "/api");
  return routes;
}

function queryOf(searchParams) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    const all = searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return query;
}

// ─── request handling ───────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (String(req.headers["content-type"] || "").includes("json")) {
    try { return JSON.parse(raw); } catch { return raw; } // handlers parse strings themselves and answer 400
  }
  return raw;
}

/** Decorate the real res with the Vercel/Express helpers handlers use. */
function decorate(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); };
  res.send = (obj) => {
    if (typeof obj === "string") { res.end(obj); return res; }
    res.json(obj); return res;
  };
  return res;
}

function serveStatic(pathname, res, headerRules) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel.endsWith("/") && rel.length > 1) rel = rel.slice(0, -1);
  rel = normalize(rel).replace(/^[/\\]+/, "");
  if (rel.split(/[\\/]/).includes("..")) return false;
  const abs = join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR)) return false;
  const candidates = rel === "" || rel === "." ? [join(PUBLIC_DIR, "index.html")] :
    [abs, `${abs}.html`, join(abs, "index.html")];
  for (const file of candidates) {
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    applyHeaders(res, headersFor(pathname, headerRules));
    res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", st.size);
    // HEAD keeps the headers and the length, drops the body.
    res.end(res.req?.method === "HEAD" ? undefined : readFileSync(file));
    return true;
  }
  return false;
}

function applyHeaders(res, headers) {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

function serialize(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) for (const one of v) p.append(k, one);
    else if (v !== undefined && v !== null) p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The request listener: redirects, static, api, rewrites, 404. */
export function createListener({ env = process.env, log = () => {} } = {}) {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const routes = buildApiRoutes();
  const handlerCache = new Map();

  const handlerFor = async (file) => {
    if (!handlerCache.has(file)) handlerCache.set(file, (await import(pathToFileURL(file).href)).default);
    return handlerCache.get(file);
  };

  return async (req, res) => {
    const started = Date.now();
    const u = new URL(req.url, "http://local");
    const originalPath = u.pathname;
    let pathname = u.pathname;
    let query = queryOf(u.searchParams);
    decorate(res); // status/json/send for handlers and the 404 below

    const finish = (status) => { log({ method: req.method, path: originalPath, status, ms: Date.now() - started }); };

    try {
      // 1. redirects (exact-path sources only)
      for (const rule of vercel.redirects || []) {
        if (rule.source === pathname) {
          applyHeaders(res, headersFor(pathname, vercel.headers));
          res.statusCode = rule.permanent ? 301 : 302;
          res.setHeader("Location", rule.destination);
          res.end();
          finish(res.statusCode);
          return;
        }
      }

      // 2. static files win first, exactly like Vercel's filesystem check
      if (req.method === "GET" || req.method === "HEAD") {
        if (serveStatic(originalPath, res, vercel.headers)) { finish(res.statusCode); return; }
      }

      // 3. api handlers
      const callApi = async () => {
        for (const route of routes) {
          const m = pathname.match(route.re);
          if (!m) continue;
          for (const [name, value] of Object.entries(m.groups || {})) query[name] = decodeURIComponent(value);
          const handler = await handlerFor(route.file);
          if (!handler) throw new Error(`api route without a default export: ${route.path}`);
          const body = await readBody(req);
          const vreq = {
            method: req.method,
            url: pathname + serialize(query),
            headers: req.headers,
            query,
            body,
          };
          // Headers match the path the client asked for, before any rewrite.
          applyHeaders(res, headersFor(originalPath, vercel.headers));
          if (req.method === "HEAD") {
            // HEAD keeps the status and headers, drops the body.
            const realEnd = res.end.bind(res);
            res.end = (chunk, ...rest) => realEnd(undefined, ...rest);
            const realWrite = res.write.bind(res);
            res.write = () => realWrite("");
          }
          await handler(vreq, res);
          return true;
        }
        return false;
      };

      if (await callApi()) { finish(res.statusCode); return; }

      // 4. rewrites (/mcp, /sign-in, /api/pulse, well-known), then api again
      const rw = rewriteFor(pathname, query, vercel.rewrites);
      if (rw) {
        pathname = rw.path;
        query = rw.query;
        if (await callApi()) { finish(res.statusCode); return; }
        // a rewrite to a static file
        if (serveStatic(pathname, res, vercel.headers)) { finish(res.statusCode); return; }
      }

      // 5. 404 — headers match the path the client asked for, not the rewrite.
      applyHeaders(res, headersFor(originalPath, vercel.headers));
      res.statusCode = 404;
      if (originalPath.startsWith("/api/") || (req.headers.accept || "").includes("json")) {
        res.json({ error: "not found" });
      } else {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("not found\n");
      }
      finish(404);
    } catch (e) {
      if (res.headersSent) { res.end(); finish(res.statusCode); return; }
      applyHeaders(res, headersFor(originalPath, vercel.headers));
      const status = e?.status || 500;
      res.statusCode = status;
      if (originalPath.startsWith("/api/")) {
        res.json({ error: status === 413 ? "payload too large" : "internal error" });
      } else {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(status === 413 ? "payload too large\n" : "internal error\n");
      }
      if (status >= 500) console.error("[serve]", req.method, originalPath, e);
      finish(status);
    }
  };
}

export function start({ host = process.env.SERVER_HOST || DEFAULT_HOST, port = Number(process.env.SERVER_PORT || DEFAULT_PORT), log } = {}) {
  const server = http.createServer(createListener({ log }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, host, port }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { host, port } = await start({ log: (e) => console.log(`${e.method} ${e.path} ${e.status} ${e.ms}ms`) });
  console.log(`logmem self-host listening on http://${host}:${port}`);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}