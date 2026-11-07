// access-model.js: rows and words for the Agent access screen. Pure, no lit import, so tests can load it.
// One shape for two identities: an operator (admin password, fleet keys) and a customer (workspace keys).
const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x, d = '') => (typeof x === 'string' ? x : d);
const ms = (x) => (typeof x === 'number' && x > 0 ? (x > 1e12 ? x : x * 1000) : null);

/** Whitelist only. A key value is never part of a list reply, and is dropped here if a server sends one. */
export function normalizeAccess(reply) {
  const r = reply && typeof reply === 'object' ? reply : {};
  return {
    keys: arr(r.keys).map((k) => ({ id: str(k?.id), agent: str(k?.agent, 'agent'), space: str(k?.space, str(k?.namespace)), label: str(k?.label), readOnly: k?.scope === 'read', createdAt: ms(k?.created_at) })),
    apps: arr(r.apps ?? r.web).map((a) => ({ id: str(a?.id), fid: str(a?.fid), app: str(a?.app, 'App'), agent: str(a?.agent, str(a?.last_call_agent)), space: str(a?.space), lastUsed: ms(a?.last_used ?? a?.last_call_at) })),
    spaces: arr(r.spaces).filter((s) => typeof s === 'string' && s),
  };
}

export const ACCESS_ROLES = ['owner', 'admin'];
/** Operators always may manage. A customer needs a manager role. */
export const canManageAccess = ({ customer, role }) => !customer || ACCESS_ROLES.includes(role);

export const KEY_HELP = 'One key per agent. A key works for one space and one agent name only, and never expires. A read-only key can read but never write. Revoke a key at any time. Keep each key in that agent’s vault, never in chat or a file.';
export const APP_HELP = 'Apps such as Gemini or Claude on the web, connected through the sign-in page. Disconnect ends every token of that connection.';
export const FRESH_KEY_NOTE = 'Copy it now. It is not shown again.';
export const NOT_MANAGER = 'Your workspace owner manages agent access.';
export const accessLabel = (readOnly) => (readOnly ? 'Read only' : 'Read and write');
export const revokeQuestion = (agent) => `Revoke the key for ${agent}? That agent loses access at once.`;
export const disconnectQuestion = (app) => `Disconnect ${app}? Every token of this connection stops working.`;

/** The create-key request body. An operator names a space, a label and an access level. A customer names an agent only. */
export function createBody({ customer, agent, space, label, readOnly }) {
  const a = String(agent || '').trim();
  if (customer) return { agent: a };
  const body = { agent: a, space: String(space || ''), label: String(label || '').trim().slice(0, 80) };
  if (readOnly) body.scope = 'read';
  return body;
}
export const validAgent = (s) => /^[a-z][a-z0-9_.-]*$/.test(String(s || '').trim());
