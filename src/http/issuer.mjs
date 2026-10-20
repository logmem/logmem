// issuer.mjs — the OAuth issuer, the one MCP resource id, and the scopes.
//
// Spec: docs/superpowers/specs/2026-10-20-logmem-agent-plugin-design.md, section 8.
// ChatGPT and other MCP clients compare the issuer and the resource as exact
// strings, so neither may come from the request in a deployed server.
//
// Issuer, first match wins:
//   1. LOGMEM_ISSUER (an https origin with no path)
//   2. production: https://logmem.si
//   3. a Vercel preview: https://$VERCEL_BRANCH_URL, else https://$VERCEL_URL
//   4. local dev only (no VERCEL_ENV): the request's own host
//
// Resource: <issuer>/mcp. /api/mcp is the same endpoint (a rewrite), so a
// client that names it is normalised to /mcp, never treated as a second id.
// Every token's audience is <issuer>/mcp.
//
// Old connectors still use https://logmem.si/api/mcp. MCP SDK clients check
// that the metadata `resource` is a path prefix of the URL they connected to,
// so a client at /api/mcp gets the RFC 9728 path-specific document
// (/.well-known/oauth-protected-resource/api/mcp), which names /api/mcp. Its
// tokens are still bound to /mcp. vercel.json marks the /mcp rewrite with
// ?_lm_path=mcp, so the route can tell the two paths apart.

export const PROD_ISSUER = "https://logmem.si";
export const SCOPE_READ = "logmem:read";
export const SCOPE_WRITE = "logmem:write";
export const SCOPES = [SCOPE_READ, SCOPE_WRITE];
export const ALL_SCOPES = SCOPES.join(" ");

function originOnly(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} must be an https origin, like https://logmem.si`);
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username) {
    throw new Error(`${what} must be an https origin, like https://logmem.si`);
  }
  return u.origin;
}

export function issuerFor(req, env = process.env) {
  if (env.LOGMEM_ISSUER) return originOnly(String(env.LOGMEM_ISSUER).trim(), "LOGMEM_ISSUER");
  if (env.VERCEL_ENV === "production") return PROD_ISSUER;
  const vercelHost = env.VERCEL_BRANCH_URL || env.VERCEL_URL;
  if (env.VERCEL_ENV && vercelHost) return originOnly(`https://${vercelHost}`, "VERCEL_URL");
  const h = req?.headers || {};
  const proto = String(h["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(h["x-forwarded-host"] || h.host || "localhost").split(",")[0].trim();
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

export const canonicalResource = (req, env = process.env) => `${issuerFor(req, env)}/mcp`;

/** "/api/mcp" when the client connected through the old path, else "/mcp". */
export function mcpPathOf(req) {
  let u;
  try {
    u = new URL(req?.url || "/", "https://logmem.local");
  } catch {
    return "/mcp";
  }
  if (u.searchParams.get("_lm_path") === "mcp") return "/mcp";
  return u.pathname === "/api/mcp" || u.pathname.startsWith("/api/mcp/") ? "/api/mcp" : "/mcp";
}

/** The protected resource metadata URL for the path this client used. */
export function resourceMetadataUrl(req, env = process.env) {
  const base = `${issuerFor(req, env)}/.well-known/oauth-protected-resource`;
  return mcpPathOf(req) === "/api/mcp" ? `${base}/api/mcp` : base;
}

/**
 * A client's `resource` parameter, as the one resource id. Absent means the
 * canonical resource. Returns { resource } or { error: "invalid_target" }.
 */
export function bindResource(value, req, env = process.env) {
  const canon = canonicalResource(req, env);
  if (value === undefined || value === null || value === "") return { resource: canon };
  if (typeof value !== "string") return { error: "invalid_target" };
  const issuer = issuerFor(req, env);
  const v = value.replace(/\/+$/, "");
  if (v === canon || v === `${issuer}/api/mcp`) return { resource: canon };
  return { error: "invalid_target" };
}

/** Requested scope as the stored scope string. "mcp", empty and unknown-only mean both; write implies read. */
export function normalizeScope(scope) {
  const asked = new Set(String(scope || "").split(/\s+/).filter(Boolean));
  if (asked.has("mcp") || asked.has(SCOPE_WRITE)) return ALL_SCOPES;
  if (asked.has(SCOPE_READ)) return SCOPE_READ;
  return ALL_SCOPES;
}

export const scopesOf = (scope) => normalizeScope(scope).split(" ");
