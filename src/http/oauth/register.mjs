// RFC 7591 — Dynamic Client Registration
// Public registration enabled per MCP authorization spec recommendation.
// Each client must register before /authorize. PKCE is REQUIRED at /authorize
// regardless of token_endpoint_auth_method.

import { registerClient } from "./_lib/storage.mjs";

export const config = { runtime: "nodejs" };

const ALLOWED_GRANTS = new Set(["authorization_code", "refresh_token"]);
const ALLOWED_RESPONSE = new Set(["code"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const body = req.body || {};
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirect_uris.length === 0) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris[] required" });
    }
    for (const u of redirect_uris) {
      try {
        const parsed = new URL(u);
        if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("scheme");
        if (parsed.protocol === "http:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
          return res.status(400).json({ error: "invalid_redirect_uri", error_description: "http only allowed for localhost" });
        }
      } catch {
        return res.status(400).json({ error: "invalid_redirect_uri", error_description: `not a URL: ${u}` });
      }
    }

    const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
    for (const g of grants) {
      if (!ALLOWED_GRANTS.has(g)) {
        return res.status(400).json({ error: "invalid_client_metadata", error_description: `grant_type ${g} not supported` });
      }
    }
    const responses = Array.isArray(body.response_types) ? body.response_types : ["code"];
    for (const rt of responses) {
      if (!ALLOWED_RESPONSE.has(rt)) {
        return res.status(400).json({ error: "invalid_client_metadata", error_description: `response_type ${rt} not supported` });
      }
    }

    const auth_method = body.token_endpoint_auth_method || "none";
    if (!["none", "client_secret_post"].includes(auth_method)) {
      return res.status(400).json({ error: "invalid_client_metadata", error_description: `auth_method ${auth_method} not supported` });
    }

    const client = await registerClient({
      redirect_uris,
      grant_types: grants,
      response_types: responses,
      token_endpoint_auth_method: auth_method,
      client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null,
      scope: body.scope || "mcp",
    });

    res.status(201).setHeader("Content-Type", "application/json").json(client);
  } catch (e) {
    res.status(500).json({ error: "server_error", error_description: e.message });
  }
}
