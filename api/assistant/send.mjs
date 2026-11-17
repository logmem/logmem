import { withCustomerDashboard } from "../../src/http/customer-dashboard.mjs";
// POST /api/assistant/send — promote a draft to a live ask (or note) as the person.
//
// Spec: docs/superpowers/specs/2026-11-06-builtin-drafting-agent-design.md §5.5 / §10.3
// Phase 0: no model. Same gates as /api/decide.

import { fromDescriptor, descriptorFromEnv } from "../../src/lib/backend.mjs";
import { webStore } from "../../src/http/web-store.mjs";
import { isAdmin, adminEnabled, viewSpaces } from "../../src/http/admin-auth.mjs";
import { sendServerError } from "../../src/http/log.mjs";
import { applyRateLimit, ROUTE_CLASSES } from "../../src/http/rate-limit.mjs";
import { getDraft, markDraftSent, DraftError } from "../../src/core/drafts.mjs";
import { registerAsk, RegisterAskError } from "../../src/core/register-ask.mjs";
import { deciderFrom } from "../decide.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };
export const INTENT = "assistant-send";

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
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "bad_request", message: "POST only" });
    }
    if (!adminEnabled(env)) return res.status(401).json({ ok: false, error: "unauthenticated", message: "admin app is off" });
    if (!isAdmin(req, env)) return res.status(401).json({ ok: false, error: "unauthenticated", message: "sign in required" });
    if (String(req.headers?.["x-logmem-intent"] || "") !== INTENT || !sameOrigin(req)) {
      return res.status(403).json({ ok: false, error: "forbidden", message: `missing or wrong X-LogMem-Intent (expected '${INTENT}')` });
    }

    const b = body(req);
    if (!b) return res.status(400).json({ ok: false, error: "bad_request", message: "JSON body required: {space, draftId, requestId?}" });
    const space = String(b.space || "");
    const draftId = String(b.draftId || "");
    if (!viewSpaces(env).includes(space)) return res.status(403).json({ ok: false, error: "forbidden", message: "space not allowed" });
    if (!draftId) return res.status(400).json({ ok: false, error: "bad_request", message: "draftId required" });

    let runner = redis;
    if (!runner) {
      const d = descriptorFromEnv(env);
      if (!d) return res.status(503).json({ ok: false, error: "misconfigured", message: "storage not configured" });
      runner = fromDescriptor(d).redis;
    }
    const rateOk = await applyRateLimit(req, res, { redis: runner, routeClass: ROUTE_CLASSES.AUTH });
    if (!rateOk) return;

    const person = deciderFrom(env);
    try {
      const store = webStore(runner, space, env);
      const r = (...a) => store.redis(...a);
      const draft = await getDraft(r, { space, person, draftId });
      if (!draft) return res.status(404).json({ ok: false, error: "not_found", message: "draft not found" });
      if (draft.status !== "draft") return res.status(409).json({ ok: false, error: "not_draft", message: "draft was already sent or discarded" });

      if (draft.kind === "ask") {
        const ask = { ...draft.ask, ...(b.ask || {}) };
        // Person may edit question/action on send; reversible stays false unless person flips later (Phase 2).
        // Do not default `to` to the sender: writeDecision forbids the asker from
        // answering their own ask (OQ8 sender=approver is Phase 2). An explicit
        // draft.to still pins the receiver.
        const out = await registerAsk(store, {
          question: ask.question,
          action: ask.action,
          reversible: false,
          where: ask.where,
          to: ask.to && ask.to !== person ? ask.to : undefined,
          origin: draft.id,
          asker: person,
          via: "web",
          now: now || Date.now,
        });
        const sent = await markDraftSent(r, { space, person, draftId, trail: out.trail });
        return res.status(200).json({ ok: true, contract: 1, trail: out.trail, draft: { id: sent.id, status: sent.status } });
      }

      if (draft.kind === "note") {
        const channel = draft.note?.channel || "agent-coordination";
        const summary = String((b.note && b.note.summary) || draft.note?.summary || "");
        if (!summary) return res.status(400).json({ ok: false, error: "bad_request", message: "note summary required" });
        const t = typeof now === "function" ? now() : (now || Date.now());
        const who = person.replace(/^human:/, "");
        const entry = {
          ts: t,
          kind: "memo",
          by: person,
          via: "web",
          byline: `${who} (via web)`,
          trail: `note-${draftId}-${t}`,
          summary,
          payload: { from_draft: draftId },
        };
        await store.append("channel", channel, entry);
        const sent = await markDraftSent(r, { space, person, draftId, trail: entry.trail });
        return res.status(200).json({ ok: true, contract: 1, trail: entry.trail, draft: { id: sent.id, status: sent.status } });
      }

      return res.status(400).json({ ok: false, error: "bad_request", message: "unknown draft kind" });
    } catch (e) {
      if (e instanceof DraftError) {
        const status = e.code === "not_found" ? 404 : e.code === "not_draft" ? 409 : 400;
        return res.status(status).json({ ok: false, error: e.code, message: e.message });
      }
      if (e instanceof RegisterAskError) {
        const status = e.code === "conflict" ? 409 : 400;
        return res.status(status).json({ ok: false, error: e.code, message: e.message });
      }
      return sendServerError(res, "assistant-send", e);
    }
  };
}

const handler = createHandler();
export default withCustomerDashboard(handler);
