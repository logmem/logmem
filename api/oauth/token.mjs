// OAuth token endpoint. Handles two grants:
//   - authorization_code (with PKCE code_verifier)
//   - refresh_token
//
// Per MCP spec: PKCE verification is mandatory; client_secret check only when
// the registered client used token_endpoint_auth_method=client_secret_post.

import { consumeAuthCode, consumeRefresh, getClient, mintTokens, sha256base64url, safeEqual, assertKekReady } from "./_lib/storage.mjs";

export const config = { runtime: "nodejs" };

function bad(res, status, error, description) {
  res.status(status).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error, error_description: description }));
}

function readBody(req) {
  // Vercel auto-parses JSON; for application/x-www-form-urlencoded it leaves
  // the body raw. Handle both.
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const out = {};
    for (const pair of req.body.split("&")) {
      const [k, v] = pair.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
    }
    return out;
  }
  return {};
}

// client_secret_post: constant-time compare; a record without a stored
// secret never matches (no "" == "" bypass).
function secretMatches(client, presented) {
  if (typeof client.client_secret !== "string" || !client.client_secret) return false;
  return safeEqual(String(presented ?? ""), client.client_secret);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return bad(res, 405, "method_not_allowed");

  try {
    const body = readBody(req);
    const grant_type = body.grant_type;
    // Refuse before consuming a code/refresh token we could not re-seal.
    assertKekReady();

    if (grant_type === "authorization_code") {
      const { code, redirect_uri, client_id, client_secret, code_verifier } = body;
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        return bad(res, 400, "invalid_request", "code, redirect_uri, client_id, code_verifier required");
      }

      const client = await getClient(client_id);
      if (!client) return bad(res, 400, "invalid_client", "unknown client_id");
      if (client.token_endpoint_auth_method === "client_secret_post" && !secretMatches(client, client_secret)) {
        return bad(res, 401, "invalid_client", "client_secret mismatch");
      }

      const codeRecord = await consumeAuthCode(code);
      if (!codeRecord) return bad(res, 400, "invalid_grant", "auth code expired or already used");
      if (codeRecord.client_id !== client_id) return bad(res, 400, "invalid_grant", "code/client mismatch");
      if (codeRecord.redirect_uri !== redirect_uri) return bad(res, 400, "invalid_grant", "redirect_uri mismatch");

      // PKCE verification — S256 only
      const computed = sha256base64url(code_verifier);
      if (!safeEqual(computed, String(codeRecord.code_challenge ?? ""))) {
        return bad(res, 400, "invalid_grant", "code_verifier failed PKCE check");
      }

      const tokens = await mintTokens({
        client_id,
        scope: codeRecord.scope,
        sub: codeRecord.sub,
        upstash_url: codeRecord.upstash_url,
        upstash_token: codeRecord.upstash_token,
        backend: codeRecord.backend,
        space: codeRecord.space,
      });
      res.status(200).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(tokens));
      return;
    }

    if (grant_type === "refresh_token") {
      const { refresh_token, client_id, client_secret } = body;
      if (!refresh_token || !client_id) return bad(res, 400, "invalid_request", "refresh_token + client_id required");

      const client = await getClient(client_id);
      if (!client) return bad(res, 400, "invalid_client", "unknown client_id");
      if (client.token_endpoint_auth_method === "client_secret_post" && !secretMatches(client, client_secret)) {
        return bad(res, 401, "invalid_client", "client_secret mismatch");
      }

      const rec = await consumeRefresh(refresh_token);
      if (!rec) return bad(res, 400, "invalid_grant", "refresh token invalid or already used");
      if (rec.client_id !== client_id) return bad(res, 400, "invalid_grant", "refresh/client mismatch");

      const tokens = await mintTokens({
        client_id,
        scope: rec.scope,
        sub: rec.sub,
        upstash_url: rec.upstash_url,
        upstash_token: rec.upstash_token,
        backend: rec.backend,
        space: rec.space,
      });
      res.status(200).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(tokens));
      return;
    }

    return bad(res, 400, "unsupported_grant_type", `grant_type ${grant_type} not supported`);
  } catch (e) {
    // KekMissingError / StorageConfigError carry status 503. Never echo
    // internal error text (it can include upstream bodies).
    if (e && e.status === 503) {
      return bad(res, 503, "temporarily_unavailable", "token issuance is not configured on this server");
    }
    console.error(`[oauth/token] ${e?.name || "Error"}`);
    return bad(res, 500, "server_error", "internal error");
  }
}
