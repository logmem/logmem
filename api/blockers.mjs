// /api/blockers — a person works through what agents handed to them.
//
// Spec: docs/superpowers/specs/2026-10-19-logmem-blockers-plans-design.md.
//   GET  ?space=madez                              -> { space, person, blockers: [...] }  open, oldest first
//   POST { space, trail, action: "step", step, checked } -> { ok, blocker }
//   POST { space, trail, action: "done", note? }          -> { ok, blocker }
//
// Gates: a signed-in admin (the person is human:<LOGMEM_ADMIN_ID>), the space
// must be one the web app shows, and writes need "X-LogMem-Intent: blockers"
// plus a same-origin check (the /api/decide rule). Writes go through the
// mirrored web store, so each person entry has its ACMI twin.

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { webStore } from "../src/http/web-store.mjs";
import { listBlockers, setStep, markDone, BlockerError } from "../src/core/blockers.mjs";
import { isAdmin, viewSpaces } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };
export const INTENT = "blockers";
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
    const person = personFrom(env);
    try {
      if (req.method === "GET") {
        const space = String(new URL(req.url || "/", "https://x").searchParams.get("space") || viewSpaces(env)[0] || "");
        if (!viewSpaces(env).includes(space)) return res.status(403).json({ error: `space '${space}' is not shown here` });
        const store = webStore(runner, space, env);
        // A blocker for this person, or for any person when the deploy has one admin.
        const blockers = (await listBlockers(store)).filter((b) => b.to === person || person === "human:admin");
        return res.status(200).json({ space, spaces: viewSpaces(env), person, blockers });
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
      if (b.action === "step") {
        const blocker = await setStep(store, String(b.trail || ""), { ...opts, step: Number(b.step), checked: b.checked === true });
        return res.status(200).json({ ok: true, blocker });
      }
      if (b.action === "done") {
        const blocker = await markDone(store, String(b.trail || ""), { ...opts, note: typeof b.note === "string" ? b.note : undefined });
        return res.status(200).json({ ok: true, blocker });
      }
      return res.status(400).json({ error: "action must be step or done" });
    } catch (e) {
      if (e instanceof BlockerError) return res.status(400).json({ error: e.message });
      return sendServerError(res, "blockers", e);
    }
  };
}

export default createHandler();
