import { withCustomerDashboard } from "../../../src/http/customer-dashboard.mjs";
// /api/assistant/drafts — list / patch / discard drafts for the signed-in person.
//
// Spec: docs/superpowers/specs/2026-11-06-builtin-drafting-agent-design.md §10.2
// Phase 0 foundations (no model).

import { fromDescriptor, descriptorFromEnv } from "../../../src/lib/backend.mjs";
import { webStore } from "../../../src/http/web-store.mjs";
import { isAdmin, adminEnabled, viewSpaces } from "../../../src/http/admin-auth.mjs";
import { sendServerError } from "../../../src/http/log.mjs";
import { applyRateLimit, ROUTE_CLASSES } from "../../../src/http/rate-limit.mjs";
import { listDrafts, updateDraft, discardDraft, getDraft, DraftError } from "../../../src/core/drafts.mjs";
import { deciderFrom } from "../../decide.mjs";

export const config = { runtime: "nodejs", maxDuration: 15 };
export const INTENT = "assistant-drafts";

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

function draftIdFromUrl(req) {
  try {
    const u = new URL(req.url || "/", "https://logmem.local");
    const parts = u.pathname.split("/").filter(Boolean);
    // /api/assistant/drafts/:id
    const i = parts.indexOf("drafts");
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch { /* ignore */ }
  return null;
}

export function createHandler({ env = process.env, redis } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (!adminEnabled(env)) return res.status(401).json({ ok: false, error: "unauthenticated", message: "admin app is off" });
    if (!isAdmin(req, env)) return res.status(401).json({ ok: false, error: "unauthenticated", message: "sign in required" });

    let runner = redis;
    if (!runner) {
      const d = descriptorFromEnv(env);
      if (!d) return res.status(503).json({ ok: false, error: "misconfigured", message: "storage not configured" });
      runner = fromDescriptor(d).redis;
    }
    const rateOk = await applyRateLimit(req, res, { redis: runner, routeClass: ROUTE_CLASSES.AUTH });
    if (!rateOk) return;

    const person = deciderFrom(env);
    const method = req.method;
    const id = draftIdFromUrl(req);

    try {
      if (method === "GET") {
        const space = String(new URL(req.url || "/", "https://logmem.local").searchParams.get("space") || "");
        if (!viewSpaces(env).includes(space)) return res.status(403).json({ ok: false, error: "forbidden", message: "space not allowed" });
        const store = webStore(runner, space, env);
        const drafts = await listDrafts((...a) => store.redis(...a), { space, person });
        return res.status(200).json({ ok: true, contract: 1, drafts });
      }

      if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
        return res.status(403).json({ ok: false, error: "forbidden", message: `missing or wrong X-LogMem-Intent (expected '${INTENT}')` });
      }

      const b = body(req) || {};
      const space = String(b.space || "");
      if (!viewSpaces(env).includes(space)) return res.status(403).json({ ok: false, error: "forbidden", message: "space not allowed" });
      const store = webStore(runner, space, env);
      const r = (...a) => store.redis(...a);

      if (method === "PATCH") {
        if (!id) return res.status(400).json({ ok: false, error: "bad_request", message: "draft id required" });
        const draft = await updateDraft(r, { space, person, draftId: id, ask: b.ask, note: b.note });
        return res.status(200).json({ ok: true, contract: 1, draft });
      }
      if (method === "DELETE") {
        if (!id) return res.status(400).json({ ok: false, error: "bad_request", message: "draft id required" });
        const draft = await discardDraft(r, { space, person, draftId: id });
        return res.status(200).json({ ok: true, contract: 1, draft });
      }
      res.setHeader("Allow", "GET, PATCH, DELETE");
      return res.status(405).json({ ok: false, error: "bad_request", message: "method not allowed" });
    } catch (e) {
      if (e instanceof DraftError) {
        const status = e.code === "not_found" ? 404 : e.code === "not_draft" ? 409 : 400;
        return res.status(status).json({ ok: false, error: e.code, message: e.message });
      }
      return sendServerError(res, "assistant-drafts", e);
    }
  };
}

const handler = createHandler();
export default withCustomerDashboard(handler);
