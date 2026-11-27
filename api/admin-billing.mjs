// api/admin-billing.mjs — GET/POST /api/admin-billing -> Admin View for subscription, billing, and plan limits.
import { customerRedis } from "../src/http/jail.mjs";
import {
  resolveAdminBillingActor,
  listAdminBillingWorkspaces,
  updateAdminWorkspaceBilling,
} from "../src/http/billing-plans.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers?.host || ""); } catch { return false; }
}

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const r = deps.redis ? deps.redis() : customerRedis(deps.env);
      const actor = await resolveAdminBillingActor(req, { ...deps, redis: r });

      if (req.method === "GET") {
        const url = new URL(req.url || "/api/admin-billing", "https://logmem.si");
        const out = await listAdminBillingWorkspaces({
          redis: r,
          search: url.searchParams.get("q") || "",
          planFilter: url.searchParams.get("plan") || "",
          statusFilter: url.searchParams.get("status") || "",
          now: deps.now,
        });
        return res.status(200).json({ ...out, actor });
      }

      if (req.method === "POST") {
        if (String(req.headers?.["x-logmem-intent"] || "").trim() !== "admin-billing") {
          return res.status(403).json({ error: "missing_intent" });
        }
        if (!sameOrigin(req)) {
          return res.status(403).json({ error: "bad_origin" });
        }
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const out = await updateAdminWorkspaceBilling(
          {
            workspaceId: body.workspaceId,
            actorId: actor.actorId,
            plan: body.plan,
            billingStatus: body.billingStatus,
            billingEmail: body.billingEmail,
            billingNote: body.billingNote,
            externalCustomerId: body.externalCustomerId,
            limitOverrides: body.limitOverrides,
            clearOverrides: Boolean(body.clearOverrides),
            requestId: body.requestId,
          },
          { ...deps, redis: r }
        );
        return res.status(200).json(out);
      }

      return res.status(405).json({ error: "method_not_allowed" });
    } catch (e) {
      if (Number.isInteger(e?.status) && typeof e?.code === "string") {
        return res.status(e.status).json({ error: e.code, message: e.message });
      }
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
