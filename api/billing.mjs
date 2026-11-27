// api/billing.mjs — GET/POST /api/billing -> User View subscription, billing, and plan limits.
import { customerIdentity } from "../src/http/customer-http.mjs";
import { customerRedis } from "../src/http/jail.mjs";
import { getUserBillingOverview, updateUserBillingSettings } from "../src/http/billing-plans.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const { session, redis } = await customerIdentity(req, deps);
      const r = redis || customerRedis(deps.env);

      if (req.method === "GET") {
        const url = new URL(req.url || "/api/billing", "https://logmem.si");
        const workspaceId = url.searchParams.get("workspaceId") || null;
        const out = await getUserBillingOverview({
          userId: session?.userId,
          workspaceId,
          deps: { ...deps, redis: r },
        });
        return res.status(200).json(out);
      }

      if (req.method === "POST") {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const out = await updateUserBillingSettings(
          {
            userId: session?.userId,
            workspaceId: body.workspaceId,
            action: body.action,
            billingEmail: body.billingEmail,
            requestedPlan: body.requestedPlan,
            note: body.note,
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
