// api/integrations.mjs — GET list with status and last error, POST test (Phase 6.2 slice 5).
//
//   GET  /api/integrations            -> { ok, data: { integrations: [...] } }
//   POST { action: "test", id }       -> { ok, status: "ok" | "error", error? }
//        needs X-LogMem-Intent: integrations + same origin
//
// Rows carry names and presence only; the loader never emits a secret value.
// Signed-in is not enough: owner or admin, the same bar as /api/plan and space
// export. A missing session is 401 from customerIdentity; any other role is 403.
// POST reads only the parsed body (jsonBody), never the raw request body.
import { customerIdentity, requireIntent, jsonBody } from "../src/http/customer-http.mjs";
import { loadIntegrationSecrets, testIntegration, loadLastErrors } from "../src/http/integrations.mjs";
import { listWorkspaces } from "../src/http/workspaces.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const err = (code, status) => Object.assign(new Error(code), { code, status });
const MANAGER_ROLES = new Set(["owner", "admin"]);
const TEST_FIELDS = new Set(["action", "id"]);

async function requireManager(session, redis) {
  const workspaces = await listWorkspaces({ userId: session?.userId }, { redis });
  if (!workspaces.some((w) => MANAGER_ROLES.has(w.role))) throw err("forbidden", 403);
}

/** The only POST input the handler may use. Extra fields are rejected, not forwarded. */
function testBody(req) {
  const parsed = jsonBody(req);
  if (Object.keys(parsed).some((key) => !TEST_FIELDS.has(key))) throw err("invalid_action", 400);
  if (parsed.action !== "test" || typeof parsed.id !== "string") throw err("invalid_action", 400);
  return { action: parsed.action, id: parsed.id };
}

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const { session, redis, env } = await customerIdentity(req, deps);
      await requireManager(session, redis);

      if (req.method === "GET") {
        const integrations = loadIntegrationSecrets(env);
        const lastErrors = await loadLastErrors(redis);
        for (const row of integrations) row.lastError = lastErrors[row.id] ?? null;
        return res.status(200).json({ ok: true, data: { integrations } });
      }

      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      requireIntent(req, "integrations");
      const b = testBody(req);
      const verdict = await testIntegration(b.id, { env, redis, fetchImpl: deps.fetchImpl });
      if (verdict.error === "unknown_integration") throw err("unknown_integration", 404);
      return res.status(200).json({ ok: verdict.ok, status: verdict.ok ? "ok" : "error", error: verdict.error ?? null });
    } catch (e) {
      if (Number.isInteger(e?.status) && typeof e?.code === "string") return res.status(e.status).json({ error: e.code });
      return res.status(500).json({ error: "internal_error" });
    }
  };
}

export default createHandler();
