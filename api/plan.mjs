// api/plan.mjs — GET /api/plan -> plan and usage rows for the signed-in account (Phase 6.2 slice 4).
// Self only: rows come from the caller's own workspace (owner or admin bar).
//   200 { ok, data: { plan: [...rows], usage: [...rows] } }
//   405 | 401 sign_in_required | 403 forbidden | 400 unknown_plan
//   503 customer_dashboard_disabled | 500 internal_error
import { customerIdentity } from "../src/http/customer-http.mjs";
import { planUsageFor } from "../src/http/plan-usage.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
      const { session, redis } = await customerIdentity(req, deps);
      const out = await planUsageFor({ userId: session?.userId, deps: { ...deps, redis } });
      return res.status(200).json(out);
    } catch (e) {
      if (Number.isInteger(e?.status) && typeof e?.code === "string") return res.status(e.status).json({ error: e.code });
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
