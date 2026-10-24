import { workspaceGrantActive } from '../../src/http/workspace-agent-keys.mjs';
// OAuth token endpoint. Handles two grants:
//   - authorization_code (with PKCE code_verifier)
//   - refresh_token
//
// Per MCP spec: PKCE verification is mandatory; client_secret check only when
// the registered client used client_secret_post or client_secret_basic.
//
// Resource (RFC 8707): the grant's resource comes from the auth code (or the
// refresh record). A `resource` the client sends here must name the same one,
// or the answer is invalid_target. Codes and grants from before resource
// binding take the canonical resource.

import { SECRET_METHODS, consumeAuthCode, consumeRefresh, getClient, mintTokens, sha256base64url, safeEqual, assertKekReady, touchClient, linkRefreshChildren } from "./_lib/storage.mjs";
import { bindResource, normalizeScope } from "../../src/http/issuer.mjs";

export const config = { runtime: "nodejs" };

function bad(res, status, error, description, { basic = false } = {}) {
  // RFC 6749 5.2: a 401 to a client that sent an Authorization header names the scheme.
  if (status === 401 && basic) res.setHeader("WWW-Authenticate", 'Basic realm="logmem"');
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

/**
 * Client credentials from an HTTP Basic header (RFC 6749 2.3.1), or null.
 * Both parts are form-urlencoded.
 */
export function basicClient(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ""));
  if (!m) return null;
  const raw = Buffer.from(m[1], "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 0) return null;
  const dec = (v) => { try { return decodeURIComponent(v.replace(/\+/g, " ")); } catch { return null; } };
  const client_id = dec(raw.slice(0, i));
  const client_secret = dec(raw.slice(i + 1));
  return client_id ? { client_id, client_secret } : null;
}

/** Merge Basic credentials into the body. A client_id in both places must match. */
function withBasic(body, header) {
  const b = basicClient(header);
  if (!b) return { body };
  if (body.client_id && body.client_id !== b.client_id) return { error: "client_id in the body and the Authorization header differ" };
  return { basic: true, body: { ...body, client_id: b.client_id, client_secret: body.client_secret ?? b.client_secret } };
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
    const merged = withBasic(readBody(req), req.headers?.authorization);
    if (merged.error) return bad(res, 401, "invalid_client", merged.error, { basic: true });
    const body = merged.body;
    const grant_type = body.grant_type;
    // Refuse before consuming a code/refresh token we could not re-seal.
    assertKekReady();

    if (grant_type === "authorization_code") {
      const { code, redirect_uri, client_id, client_secret, code_verifier } = body;
      const asked = bindResource(body.resource, req);
      if (asked.error) return bad(res, 400, "invalid_target", "unknown resource");
      if (!code || !redirect_uri || !client_id || !code_verifier) {
        return bad(res, 400, "invalid_request", "code, redirect_uri, client_id, code_verifier required");
      }

      const client = await getClient(client_id);
      if (!client) return bad(res, 400, "invalid_client", "unknown client_id");
      if (SECRET_METHODS.has(client.token_endpoint_auth_method) && !secretMatches(client, client_secret)) {
        return bad(res, 401, "invalid_client", "client_secret mismatch", { basic: !!merged.basic });
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
      const resource = codeRecord.resource || bindResource(undefined, req).resource;
      if (body.resource && asked.resource !== resource) return bad(res, 400, "invalid_target", "resource does not match the authorization");

      if (!await workspaceGrantActive(codeRecord)) return bad(res, 400, "invalid_grant", "workspace access was revoked");
      const tokens = await mintTokens({
        client_id,
        scope: normalizeScope(codeRecord.scope),
        resource,
        sub: codeRecord.sub,
        upstash_url: codeRecord.upstash_url,
        upstash_token: codeRecord.upstash_token,
        backend: codeRecord.backend,
        space: codeRecord.space,
      });
      await touchClient(client_id);
      res.status(200).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(tokens));
      return;
    }

    if (grant_type === "refresh_token") {
      const { refresh_token, client_id, client_secret } = body;
      if (!refresh_token || !client_id) return bad(res, 400, "invalid_request", "refresh_token + client_id required");
      const asked = bindResource(body.resource, req);
      if (asked.error) return bad(res, 400, "invalid_target", "unknown resource");

      const client = await getClient(client_id);
      if (!client) return bad(res, 400, "invalid_client", "unknown client_id");
      if (SECRET_METHODS.has(client.token_endpoint_auth_method) && !secretMatches(client, client_secret)) {
        return bad(res, 401, "invalid_client", "client_secret mismatch", { basic: !!merged.basic });
      }

      // client_id is checked inside consumeRefresh BEFORE the token is
      // consumed, so a mismatched client cannot burn someone else's token.
      const got = await consumeRefresh(refresh_token, client_id);
      if (!got) return bad(res, 400, "invalid_grant", "refresh token invalid or already used");
      if (got.mismatch) return bad(res, 400, "invalid_grant", "refresh/client mismatch");
      // RFC 9700 4.14: a rotated refresh token presented again. The family is
      // already revoked; the presenter (legitimate or not) gets nothing.
      if (got.reuse) return bad(res, 400, "invalid_grant", "refresh token reuse detected; all tokens for this grant were revoked");
      const rec = got.rec;
      const resource = rec.resource || bindResource(undefined, req).resource;
      if (body.resource && asked.resource !== resource) return bad(res, 400, "invalid_target", "resource does not match the grant");

      if (!await workspaceGrantActive(rec)) return bad(res, 400, "invalid_grant", "workspace access was revoked");
      const tokens = await mintTokens({
        client_id,
        scope: normalizeScope(rec.scope),
        resource,
        sub: rec.sub,
        upstash_url: rec.upstash_url,
        upstash_token: rec.upstash_token,
        backend: rec.backend,
        space: rec.space,
        fid: rec.fid, // same grant: rotation stays in the family
      });
      // Reuse may have been detected while this request was in flight; if so
      // the tokens just minted were deleted and must not be handed out.
      if ((await linkRefreshChildren(refresh_token, tokens, rec.fid)).revoked) {
        return bad(res, 400, "invalid_grant", "refresh token reuse detected; all tokens for this grant were revoked");
      }
      await touchClient(client_id);
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
