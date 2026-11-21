// api/integrations.mjs — GET list with status and last error, POST test (Phase 6.2 slice 5).
//
//   GET  /api/integrations            -> { ok, data: { integrations: [...] } }
//   POST { action: "test", id }       -> { ok, status: "ok" | "error", error? }
//        needs X-LogMem-Intent: integrations + same origin
//
// Rows carry names and presence only; the loader never emits a secret value.
// The signed-in customer scope applies (customerIdentity), matching slice 2 and 4.
import { customerIdentity, requireIntent } from "../src/http/customer-http.mjs";
import { loadIntegrationSecrets, testIntegration, loadLastErrors } from "../src/http/integrations.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const err = (code, status) => Object.assign(new Error(code), { code, status });

export function createHandler(deps = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const { session, redis, env } = await customerIdentity(req, deps);
      void session;

      if (req.method === "GET") {
        const integrations = loadIntegrationSecrets(env);
        const lastErrors = await loadLastErrors(redis);
        for (const row of integrations) row.lastError = lastErrors[row.id] ?? null;
        return res.status(200).json({ ok: true, data: { integrations } });
      }

      if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
      requireIntent(req, "integrations");
      const b = req.body && typeof req.body === "object" ? req.body : {};
      if (b.action !== "test" || typeof b.id !== "string") throw err("invalid_action", 400);
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
