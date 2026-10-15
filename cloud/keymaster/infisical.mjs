// cloud/keymaster/infisical.mjs — the keymaster's Infisical client. Injected fetch; no values or tokens leave it.
// Endpoints are pinned in ./endpoints.json from the server's own /api/docs/json.
// The additional-privilege endpoints take a project *slug*, not the project id; pass projectSlug
// (it falls back to projectId so tests and older callers still build a request).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const EP = JSON.parse(readFileSync(new URL("./endpoints.json", import.meta.url), "utf8"));
const split = (ep) => { const [method, path] = ep.split(" "); return { method, path }; };

export function createInfisical({ baseUrl, fetch, projectId, env, projectSlug = projectId }) {
  async function call(ep, { token, params = {}, query = {}, body } = {}) {
    const { method, path } = split(ep);
    const p = path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? (k === "projectId" ? projectId : "")));
    const u = new URL(baseUrl + p);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(u, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (e) {
      return { ok: false, error: `infisical unreachable (${e?.name || "error"})` };
    }
    // Never echo the response body: a server error page can repeat the token or a value.
    if (!res.ok) return { ok: false, error: `infisical ${method} ${path} returned ${res.status}` };
    try { return { ok: true, data: await res.json() }; } catch { return { ok: false, error: `infisical ${method} ${path} returned non-JSON` }; }
  }

  const listPrivileges = (token, identityId) => call(EP.privileges, { token, query: { identityId, projectSlug } });

  return {
    async login({ clientId, clientSecret }) {
      const r = await call(EP.login, { body: { clientId, clientSecret } });
      return r.ok && r.data?.accessToken ? { ok: true, token: r.data.accessToken } : { ok: false, error: r.error || "login returned no token" };
    },
    async identityIdFor({ token, identity }) {
      const m = await call(EP.memberships, { token });
      return m.ok ? (m.data?.identityMemberships || []).find((x) => x.identity?.name === identity)?.identity?.id ?? null : null;
    },
    async getSecretLength({ token, path, name }) {
      const r = await call(EP.secret, { token, params: { secretName: name }, query: { workspaceId: projectId, environment: env, secretPath: path } });
      if (!r.ok) return r;
      const v = r.data?.secret?.secretValue;
      return typeof v === "string" ? { ok: true, length: v.length } : { ok: false, error: "secret has no value" };
    },
    async listIdentityGrants({ token }) {
      const m = await call(EP.memberships, { token });
      if (!m.ok) return m;
      const grants = [];
      for (const { identity } of m.data?.identityMemberships || []) {
        if (!identity?.id) continue;
        const p = await listPrivileges(token, identity.id);
        if (!p.ok) return p;
        for (const g of p.data?.privileges || []) {
          const sp = g.permissions?.[0]?.conditions?.secretPath;
          const path = sp?.$glob ?? sp?.$eq ?? "/";
          grants.push({ identity: identity.name, identityId: identity.id, path, scope: "read", expiresAt: g.isTemporary && g.temporaryAccessEndTime ? Date.parse(g.temporaryAccessEndTime) : null, grantId: g.id });
        }
      }
      return { ok: true, grants };
    },
    async addTemporaryGrant({ token, identityId, path, ttlSeconds }) {
      if (!identityId || !path) return { ok: false, error: "identityId and path are required" };
      if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) return { ok: false, error: "ttlSeconds must be a positive integer" };
      const slug = `keymaster-${randomUUID().slice(0, 18)}`;
      const r = await call(EP.addTemporary, { token, body: { identityId, projectSlug, slug, permissions: [{ action: "read", subject: "secrets", conditions: { environment: env, secretPath: { $glob: path } } }], temporaryMode: "relative", temporaryRange: `${ttlSeconds}s`, temporaryAccessStartTime: new Date().toISOString() } });
      if (!r.ok) return r;
      return r.data?.privilege?.id ? { ok: true, grantId: r.data.privilege.id } : { ok: false, error: "grant returned no id" };
    },
    // Infisical deletes by privilege slug + identity id; grantId is the privilege id, so look the slug up first.
    async revokeGrant({ token, grantId, identityId }) {
      if (!grantId || !identityId) return { ok: false, error: "grantId and identityId are required" };
      const p = await listPrivileges(token, identityId);
      if (!p.ok) return p;
      const g = (p.data?.privileges || []).find((x) => x.id === grantId);
      if (!g) return { ok: false, error: "grant not found" };
      const r = await call(EP.revoke, { token, body: { privilegeSlug: g.slug, identityId, projectSlug } });
      return r.ok ? { ok: true } : r;
    },
  };
}
