// RFC 7591 — Dynamic Client Registration
// Public registration enabled per MCP authorization spec recommendation.
// Each client must register before /authorize. PKCE is REQUIRED at /authorize
// regardless of token_endpoint_auth_method.
//
// Registration is unauthenticated, so the body is bounded: at most 5
// redirect_uris (each <= 2048 chars, https only except http://localhost and
// http://127.0.0.1, no fragment), client_name <= 100 chars, scope <= 64 chars,
// token_endpoint_auth_method in {none, client_secret_post}. Client records
// expire after 30 days without use (see storage.mjs). Rate limiting is a
// platform concern (Vercel Firewall), not handled here.

import { registerClient } from "./_lib/storage.mjs";

export const config = { runtime: "nodejs" };

const ALLOWED_GRANTS = new Set(["authorization_code", "refresh_token"]);
const ALLOWED_RESPONSE = new Set(["code"]);
const ALLOWED_AUTH = new Set(["none", "client_secret_post"]);
const MAX_REDIRECTS = 5;
const MAX_REDIRECT_LEN = 2048;
const MAX_NAME = 100;
const MAX_SCOPE = 64;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function invalid(error, error_description) {
  return { error, error_description };
}

/** Pure validation of a DCR body. Returns { meta } or { error, error_description }. */
export function validateRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("invalid_client_metadata", "JSON object body required");
  }

  const redirect_uris = body.redirect_uris;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return invalid("invalid_redirect_uri", "redirect_uris[] required");
  }
  if (redirect_uris.length > MAX_REDIRECTS) {
    return invalid("invalid_redirect_uri", `at most ${MAX_REDIRECTS} redirect_uris`);
  }
  for (const u of redirect_uris) {
    if (typeof u !== "string" || u.length === 0 || u.length > MAX_REDIRECT_LEN) {
      return invalid("invalid_redirect_uri", `each redirect_uri must be a string of 1-${MAX_REDIRECT_LEN} chars`);
    }
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return invalid("invalid_redirect_uri", "redirect_uri is not a valid URL");
    }
    if (parsed.hash) return invalid("invalid_redirect_uri", "redirect_uri must not contain a fragment");
    if (parsed.username || parsed.password) return invalid("invalid_redirect_uri", "redirect_uri must not contain credentials");
    if (parsed.protocol === "https:") continue;
    if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) continue;
    return invalid("invalid_redirect_uri", "redirect_uri must be https (http only for localhost / 127.0.0.1)");
  }

  const grants = body.grant_types === undefined ? ["authorization_code", "refresh_token"] : body.grant_types;
  if (!Array.isArray(grants) || grants.length === 0 || grants.length > ALLOWED_GRANTS.size) {
    return invalid("invalid_client_metadata", "grant_types must be a non-empty subset of authorization_code, refresh_token");
  }
  for (const g of grants) {
    if (!ALLOWED_GRANTS.has(g)) return invalid("invalid_client_metadata", "unsupported grant_type");
  }

  const responses = body.response_types === undefined ? ["code"] : body.response_types;
  if (!Array.isArray(responses) || responses.length !== 1 || !ALLOWED_RESPONSE.has(responses[0])) {
    return invalid("invalid_client_metadata", "response_types must be [\"code\"]");
  }

  const auth_method = body.token_endpoint_auth_method === undefined ? "none" : body.token_endpoint_auth_method;
  if (!ALLOWED_AUTH.has(auth_method)) {
    return invalid("invalid_client_metadata", "token_endpoint_auth_method must be none or client_secret_post");
  }

  let client_name = null;
  if (body.client_name !== undefined && body.client_name !== null) {
    if (typeof body.client_name !== "string" || body.client_name.length > MAX_NAME) {
      return invalid("invalid_client_metadata", `client_name must be a string of at most ${MAX_NAME} chars`);
    }
    client_name = body.client_name;
  }

  let scope = "mcp";
  if (body.scope !== undefined && body.scope !== null) {
    if (typeof body.scope !== "string" || body.scope.length === 0 || body.scope.length > MAX_SCOPE) {
      return invalid("invalid_client_metadata", `scope must be a string of 1-${MAX_SCOPE} chars`);
    }
    scope = body.scope;
  }

  return {
    meta: {
      redirect_uris: [...new Set(redirect_uris)],
      grant_types: [...new Set(grants)],
      response_types: ["code"],
      token_endpoint_auth_method: auth_method,
      client_name,
      scope,
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const v = validateRegistration(req.body || {});
    if (v.error) return res.status(400).json({ error: v.error, error_description: v.error_description });

    const client = await registerClient(v.meta);
    res.status(201).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store").json(client);
  } catch (e) {
    console.error(`[oauth/register] ${e?.name || "Error"}`);
    const status = e && e.status === 503 ? 503 : 500;
    res.status(status).json({ error: "server_error", error_description: "registration unavailable" });
  }
}
