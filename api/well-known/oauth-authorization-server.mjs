// RFC 8414 — OAuth 2.0 Authorization Server Metadata
// MCP clients (Claude, ChatGPT, Codex) discover the OAuth flow here. The
// issuer is pinned (src/http/issuer.mjs), never taken from the Host header.

import { issuerFor, SCOPES } from "../../src/http/issuer.mjs";

export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  let issuer;
  try {
    issuer = issuerFor(req);
  } catch (e) {
    console.error(`[oauth-metadata] ${e.message}`);
    return res.status(500).json({ error: "server_error" });
  }

  res.status(200).setHeader("Content-Type", "application/json").json({
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: SCOPES,
    // RFC 9207: every authorization response carries iss.
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/`,
  });
}
