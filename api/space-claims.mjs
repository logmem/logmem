// api/space-claims.mjs — Phase 3 1-Click Signed Space Claim Links API (shared by vanilla & Vercel).
//
//   GET  /api/space-claims?token=lmc_...                  -> inspect claim (signed-in recipient)
//   GET  /api/space-claims?workspaceId=...&spaceId=...    -> list claims (owner only)
//   POST /api/space-claims (X-LogMem-Intent: space-claims)
//     { action: "create", workspaceId, spaceId, mode, clientSafe, recipientEmail?, ttlDays? }
//     { action: "revoke", workspaceId, spaceId, claimId }
//     { action: "accept", token, targetWorkspaceId, spaceName?, requestId? }

import { customerIdentity, requireIntent, jsonBody, requestUrl, customerError } from "../src/http/customer-http.mjs";
import { WorkspaceError } from "../src/http/workspaces.mjs";
import {
  createSpaceClaim,
  listSpaceClaims,
  revokeSpaceClaim,
  inspectSpaceClaim,
  acceptSpaceClaim,
  SpaceClaimError,
} from "../src/http/space-claims.mjs";

export const config = { runtime: "nodejs", maxDuration: 60 };

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const { session: s, redis } = await customerIdentity(req, deps);
      const d = { redis, now: deps.now ? deps.now() : Date.now(), limits: deps.limits };

      if (req.method === "GET") {
        const q = requestUrl(req).searchParams;
        const token = q.get("token");
        if (token) {
          const preview = await inspectSpaceClaim({ token, verifiedEmail: s.email || "" }, d);
          return res.status(200).json(preview);
        }
        const workspaceId = q.get("workspaceId");
        const spaceId = q.get("spaceId");
        if (!workspaceId || !spaceId) throw new WorkspaceError("invalid_request", 400);
        const claims = await listSpaceClaims({ actorId: s.userId, workspaceId, spaceId }, d);
        return res.status(200).json({ ok: true, claims });
      }

      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      requireIntent(req, "space-claims");
      const b = jsonBody(req);

      if (b.action === "create") {
        const r = await createSpaceClaim(
          {
            actorId: s.userId,
            workspaceId: b.workspaceId,
            spaceId: b.spaceId,
            mode: b.mode,
            clientSafe: b.clientSafe !== false,
            recipientEmail: b.recipientEmail || "",
            ttlDays: b.ttlDays,
          },
          d,
        );
        const origin = requestUrl(req).origin;
        const claimUrl = new URL(`/app?claim=${encodeURIComponent(r.token)}`, origin).toString();
        return res.status(200).json({ ...r, claimUrl });
      }

      if (b.action === "revoke") {
        const r = await revokeSpaceClaim(
          { actorId: s.userId, workspaceId: b.workspaceId, spaceId: b.spaceId, claimId: b.claimId },
          d,
        );
        return res.status(200).json(r);
      }

      if (b.action === "accept") {
        const r = await acceptSpaceClaim(
          {
            userId: s.userId,
            verifiedEmail: s.email || "",
            targetWorkspaceId: b.targetWorkspaceId,
            spaceName: b.spaceName,
            token: b.token,
            requestId: b.requestId,
          },
          d,
        );
        return res.status(200).json(r);
      }

      return res.status(400).json({ error: "invalid_action" });
    } catch (e) {
      if (e instanceof SpaceClaimError) return res.status(e.status).json({ error: e.code, message: e.message });
      return customerError(res, e, "space-claims");
    }
  };
}

export default createHandler();
