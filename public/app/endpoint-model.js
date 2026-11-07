// endpoint-model.js: contracts for the screens whose backend is still being built (admin plan, phase 5).
// Pure, no imports from lit, so tests can load it. Each endpoint has: a url, safe defaults, a normalizer
// that keeps only the fields a screen may show, and a status reading that tells "not built yet" from "failed".
import { CONTRACT } from './data-defaults.js';
import { noticeLine } from './session-states.js';

const arr = (x) => (Array.isArray(x) ? x : []);
const str = (x, d = '') => (typeof x === 'string' ? x : d);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const iso = (x) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null);

export const STATUS_WORD = { ok: 'Working', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };
const status = (x) => (Object.hasOwn(STATUS_WORD, x) ? x : 'unknown');

/** Whitelist only. A secret value, token or key in a reply is dropped here and cannot reach a view. */
export const ENDPOINTS = {
  integrations: {
    url: '/api/integrations', title: 'Integrations',
    defaults: () => ({ integrations: [] }),
    normalize: (r) => ({ integrations: arr(r?.integrations).map((i) => ({ id: str(i?.id), name: str(i?.name, 'Integration'), status: status(i?.status), checkedAt: iso(i?.checked_at), lastError: str(i?.last_error) || null })) }),
  },
  usage: {
    url: '/api/usage', title: 'Plan and usage',
    defaults: () => ({ plan: null, usage: [] }),
    normalize: (r) => ({ plan: r?.plan && typeof r.plan === 'object' ? { id: str(r.plan.id), name: str(r.plan.name, 'Plan'), spacesLimit: num(r.plan.spaces_limit) } : null, usage: arr(r?.usage).map((u) => ({ metric: str(u?.metric, 'Metric'), used: num(u?.used), limit: num(u?.limit) })) }),
  },
  sessions: {
    url: '/api/sessions', title: 'Sessions',
    defaults: () => ({ sessions: [] }),
    normalize: (r) => ({ sessions: arr(r?.sessions).map((s) => ({ id: str(s?.id), device: str(s?.device, 'Unknown device'), lastSeen: iso(s?.last_seen), current: s?.current === true })) }),
  },
  platform: {
    url: '/api/platform', title: 'Platform overview',
    defaults: () => ({ workspaces: [] }),
    normalize: (r) => ({ workspaces: arr(r?.workspaces).map((w) => ({ id: str(w?.id), name: str(w?.name, 'Workspace'), spaces: num(w?.spaces), members: num(w?.members) })) }),
  },
};
export const ENDPOINT_KEYS = Object.keys(ENDPOINTS);

/**
 * Read one reply. available:false means the server has no such endpoint yet (404, 405, 501): a screen shows
 * "not available yet", never a failure. A wrong contract version is rejected. A missing one is accepted.
 */
export function interpret(key, httpStatus, body) {
  const def = ENDPOINTS[key];
  if (!def) return { ok: false, available: false, stale: false, error: 'Unknown screen.', data: {} };
  const empty = def.defaults();
  if ([404, 405, 501].includes(httpStatus)) return { ok: false, available: false, stale: false, error: null, data: empty };
  if (httpStatus === 401 || httpStatus === 403) return { ok: false, available: true, stale: false, error: noticeLine({ status: httpStatus }), data: empty };
  if (!(httpStatus >= 200 && httpStatus < 300)) return { ok: false, available: true, stale: false, error: 'Could not load this screen. Try again in a minute.', data: empty };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, available: true, stale: true, error: 'LogMem sent a reply this page cannot read.', data: empty };
  const v = body.contract != null ? body.contract : body.__contract;
  if (v != null && Number(v) !== CONTRACT) return { ok: false, available: true, stale: true, error: 'This page and the LogMem server do not match. Reload the page.', data: empty };
  return { ok: true, available: true, stale: false, error: null, data: def.normalize(body) };
}
