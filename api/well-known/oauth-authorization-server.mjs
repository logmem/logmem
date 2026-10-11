// RFC 8414 — OAuth 2.0 Authorization Server Metadata
// MCP clients (Claude Web/Desktop) discover OAuth flow via this endpoint.

export const config = { runtime: "nodejs" };

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const issuer = `${proto}://${host}`;

  res.status(200).setHeader("Content-Type", "application/json").json({
    issuer,
    authorization_endpoint: `${issuer}/api/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: ["mcp"],
    revocation_endpoint: `${issuer}/api/oauth/token`, // sentinel; revocation handled by token-rotate
    service_documentation: `${issuer}/`,
  });
}
