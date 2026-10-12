// log.mjs — one JSON line per request on stdout, for Vercel runtime logs and
// any log drain attached to the project.
//
//   logRequest({ route: "/api/health", method: "GET", ms: 12, ok: true, status: 200 })
//   -> {"ts":"2026-10-12T...","level":"info","route":"/api/health","method":"GET","ms":12,"ok":true,"status":200}
//
// Never pass request bodies, headers, tokens or backend URLs in here. `err`
// is reduced to a short message string.

import { randomBytes } from "node:crypto";

const MAX_ERR = 300;

function errText(err) {
  if (err == null || err === "") return undefined;
  const s = typeof err === "string" ? err : err?.message || String(err);
  return s.length > MAX_ERR ? `${s.slice(0, MAX_ERR)}...` : s;
}

/** Build the log record (exported for tests). Undefined fields are dropped. */
export function requestRecord({ route, method, tool, ms, ok, status, err, ref } = {}, now = () => new Date()) {
  const rec = {
    ts: now().toISOString(),
    level: ok === false || (Number(status) >= 500) ? "error" : "info",
    route,
    method,
    tool,
    ms: Number.isFinite(ms) ? Math.round(ms) : undefined,
    ok,
    status,
    err: errText(err),
    ref,
  };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return rec;
}

export function logRequest(fields, { sink = console.log, now } = {}) {
  try {
    sink(JSON.stringify(requestRecord(fields, now)));
  } catch {
    /* logging must never break a request */
  }
}

/** What a client sees on any 500: no exception text, no backend detail. */
export const GENERIC_ERROR = "internal error";

/**
 * Answer 500 with a generic message and a short ref; the error detail goes to
 * the server log only (same ref, so an operator can find it). Use for every
 * unexpected failure in an /api route.
 */
export function sendServerError(res, route, err, { sink } = {}) {
  const ref = randomBytes(6).toString("hex");
  logRequest({ route, ok: false, status: 500, err, ref }, sink ? { sink } : {});
  if (res.headersSent) return res;
  return res.status(500).json({ error: GENERIC_ERROR, ref });
}
