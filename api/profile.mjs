// api/profile.mjs — GET /api/profile -> profile and security rows for the signed-in account.
// Phase 6.2 slice 2 [opencode]. Self only: rows come from the session userId,
// the handler accepts no user id parameter. GET only, no intent header (read path).
//
//   200 { ok: true, data: { profile: [...rows], security: [...rows] } }
//   405 method_not_allowed | 401 sign_in_required | 404 account_not_found
//   503 clerk_unconfigured | 502 clerk_unavailable | 500 internal_error
import { customerIdentity } from "../src/http/customer-http.mjs";
import { accountRows, AccountError } from "../src/http/account.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });
      const { session, env } = await customerIdentity(req, deps);
      const out = await accountRows({ userId: session?.userId, env, clerk: deps.clerk });
      return res.status(200).json(out);
    } catch (e) {
      // WorkspaceError from customerIdentity (sign_in_required, account_suspended,
      // customer_dashboard_disabled) carries status + code, same as AccountError.
      if (e instanceof AccountError || (Number.isInteger(e?.status) && typeof e?.code === "string")) {
        return res.status(e.status).json({ error: e.code });
      }
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
