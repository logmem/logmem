// RFC 9728 — OAuth 2.0 Protected Resource Metadata
// MCP clients read this after a 401 from the MCP endpoint to learn which
// authorization server protects it. The resource is <issuer>/mcp, and every
// token is bound to it. The path-specific document for the old /api/mcp URL
// (/.well-known/oauth-protected-resource/api/mcp, reached through a rewrite
// that passes ?path=) names /api/mcp, so MCP SDK clients configured with that
// URL pass their resource prefix check. See src/http/issuer.mjs.

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

  const url = new URL(req.url || "/", "https://logmem.local");
  const suffix = (url.searchParams.get("path") || url.pathname.replace(/^.*\/oauth-protected-resource\/?/, "")).replace(/^\/+|\/+$/g, "");
  res.status(200).setHeader("Content-Type", "application/json").json({
    resource: suffix === "api/mcp" ? `${issuer}/api/mcp` : `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/`,
  });
}
