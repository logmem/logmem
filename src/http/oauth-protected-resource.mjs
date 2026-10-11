// RFC 9728 — OAuth 2.0 Protected Resource Metadata
// MCP clients hit this on a 401 from the resource (acmi-product /api/mcp) to
// learn which authorization server protects it.

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
    resource: `${issuer}/api/mcp`,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/mcp.html`,
  });
}
