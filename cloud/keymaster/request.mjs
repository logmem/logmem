// cloud/keymaster/request.mjs — the payload an agent puts on a logmem_ask to request a secret.
export const MAX_TTL_SECONDS = 90 * 86400;
export const KEYMASTER_IDENTITY = "agent-keymaster";
const UNIT = { m: 60, h: 3600, d: 86400 };
const PATH_RE = /^(\/[A-Za-z0-9_-]+)+$/;
const NAME_RE = /^[A-Za-z0-9_]{1,128}$/;
const IDENTITY_RE = /^agent-([a-z0-9][a-z0-9-]{0,62})$/;
const SENSITIVE = (path, name) => path.startsWith("/fleet-shared/acmi") || /STRIPE|WHOP|PAYPAL|BRIDGE/i.test(name);

export function parseTtl(s) {
  const m = /^(\d{1,4})([mhd])$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}

export function parseRequest(p = {}) {
  const ref = String(p.secret ?? "");
  const i = ref.lastIndexOf("/");
  const path = i > 0 ? ref.slice(0, i) : "", name = ref.slice(i + 1);
  if (!PATH_RE.test(path) || !NAME_RE.test(name)) return { ok: false, error: "secret must be /path/NAME" };
  const id = IDENTITY_RE.exec(String(p.for ?? ""));
  if (!id) return { ok: false, error: "for must be agent-<id>" };
  if (p.for === KEYMASTER_IDENTITY) return { ok: false, error: "the keymaster cannot grant to itself" };
  if ((p.scope ?? "read") !== "read") return { ok: false, error: "scope must be read" };
  const ttlSeconds = parseTtl(p.ttl);
  if (!ttlSeconds) return { ok: false, error: "ttl is required, like 30d, 12h or 90m" };
  if (ttlSeconds > MAX_TTL_SECONDS) return { ok: false, error: "ttl is over 90d" };
  return { ok: true, req: { secret_ref: ref, path, name, agent: id[1], identity: p.for, scope: "read", ttlSeconds, sensitive: SENSITIVE(path, name) } };
}
