// /api/work — the live app's person endpoints, one function behind rewrites:
//   GET  /api/pulse?space=            -> { rev }                 the change counter
//   GET  /api/needs?space=            -> { person, count, items } open tasks and decisions
//   POST /api/nudge   { space, job, agent?, note? }
//   POST /api/unblock { space, job, note }
//   POST /api/lane    { space, plan, status: p0|active|parked, why?, until? }
//   POST /api/confirm-done { space, job, note? }   a person closes a "looks done?" job
//   POST /api/keep-open    { space, job, note? }   a person says it is still open
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-live-app-design.md.
// Gates: a signed-in admin, a space the app shows, and on writes
// "X-LogMem-Intent: work" from this site. Writes go through the mirrored web store.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { webStore } from "../src/http/web-store.mjs";
import { needsView } from "../src/http/view.mjs";
import { nudge, unblock, lane, confirmDone, keepOpen, WorkError } from "../src/http/work.mjs";
import { createStore, revKey } from "../src/core/store.mjs";
import { readOnly } from "../src/lib/read-only.mjs";
import { isAdmin, viewSpaces } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };
export const INTENT = "work";
export const personFrom = (env) => `human:${String(env.LOGMEM_ADMIN_ID || "admin")}`;

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers?.host || "");
  } catch {
    return false;
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(String(req.body || ""));
  } catch {
    return null;
  }
}

export function createHandler({ env = process.env, redis, now } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!isAdmin(req, env)) return res.status(401).json({ error: "sign in required" });
    let runner = redis;
    if (!runner) {
      const d = descriptorFromEnv(env);
      if (!d) return res.status(503).json({ error: "storage not configured on this deployment" });
      runner = fromDescriptor(d).redis;
    }
    const url = new URL(req.url || "/", "https://x");
    const op = String(url.searchParams.get("op") || "");
    const person = personFrom(env);
    try {
      if (req.method === "GET") {
        const space = String(url.searchParams.get("space") || viewSpaces(env)[0] || "");
        if (!viewSpaces(env).includes(space)) return res.status(403).json({ error: `space '${space}' is not shown here` });
        const r = readOnly(runner);
        if (op === "pulse") return res.status(200).json({ space, rev: Number((await r("GET", revKey(space))) || 0) });
        if (op === "needs") return res.status(200).json({ space, spaces: viewSpaces(env), ...(await needsView(createStore(r, { space }), r, space, { person, secret: env.LOGMEM_DECIDE_SECRET })) });
        return res.status(404).json({ error: "unknown op" });
      }
      if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ error: `missing or wrong X-LogMem-Intent header (expected '${INTENT}' from this site)` });
      }
      const b = body(req);
      if (!b) return res.status(400).json({ error: "JSON body required" });
      if (typeof b.space !== "string" || !viewSpaces(env).includes(b.space)) return res.status(403).json({ error: "space is not shown here" });
      const store = webStore(runner, b.space, env);
      const opts = { by: person, ...(now ? { now } : {}) };
      if (op === "nudge") return res.status(200).json(await nudge(store, { ...opts, job: b.job, agent: b.agent, note: b.note }));
      if (op === "unblock") return res.status(200).json(await unblock(store, { ...opts, job: b.job, note: b.note }));
      if (op === "confirm_done") return res.status(200).json(await confirmDone(store, { ...opts, job: b.job, note: b.note }));
      if (op === "keep_open") return res.status(200).json(await keepOpen(store, { ...opts, job: b.job, note: b.note }));
      if (op === "lane") return res.status(200).json(await lane(store, { ...opts, plan: b.plan, status: b.status, why: b.why, until: b.until }));
      return res.status(404).json({ error: "unknown op" });
    } catch (e) {
      if (e instanceof WorkError) return res.status(e.status).json({ error: e.message });
      if (e?.code === "bad_agent_id") return res.status(400).json({ error: e.message });
      return sendServerError(res, "work", e);
    }
  };
}

export default createHandler();
