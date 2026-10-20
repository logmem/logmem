// RFC 7009 — OAuth 2.0 Token Revocation.
//
// POST /api/oauth/revoke   token=<access or refresh token>&client_id=...[&client_secret=...]
//
// A public client names itself with client_id; a client_secret_post client
// also sends its secret. A refresh token revokes the whole grant; an access
// token revokes itself (storage.revokeToken). token_type_hint is accepted and
// not needed: both kinds are looked up. An unknown, expired or foreign token
// still answers 200, so the endpoint never tells a caller whether a token exists.

import { getClient, revokeToken, safeEqual } from "./_lib/storage.mjs";

export const config = { runtime: "nodejs" };

function reply(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return Object.fromEntries(new URLSearchParams(req.body));
  return {};
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return reply(res, 405, { error: "method_not_allowed" });

  try {
    const { token, client_id, client_secret } = readBody(req);
    if (!token || typeof token !== "string") return reply(res, 400, { error: "invalid_request", error_description: "token required" });
    if (!client_id || typeof client_id !== "string") return reply(res, 401, { error: "invalid_client", error_description: "client_id required" });
    const client = await getClient(client_id);
    if (!client) return reply(res, 401, { error: "invalid_client", error_description: "unknown client_id" });
    if (client.token_endpoint_auth_method === "client_secret_post") {
      const ok = typeof client.client_secret === "string" && client.client_secret && safeEqual(String(client_secret ?? ""), client.client_secret);
      if (!ok) return reply(res, 401, { error: "invalid_client", error_description: "client_secret mismatch" });
    }
    await revokeToken(token, client_id);
    return reply(res, 200, {});
  } catch (e) {
    if (e && e.status === 503) return reply(res, 503, { error: "temporarily_unavailable" });
    console.error(`[oauth/revoke] ${e?.name || "Error"}`);
    return reply(res, 500, { error: "server_error" });
  }
}
