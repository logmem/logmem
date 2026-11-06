// data-defaults.js — what every view may assume about a backend reply. Pure, no imports, so tests can load it.
// A reply that is missing a list gets an empty list. A reply that is not an object becomes an empty object.
export const CONTRACT = 1;
export const KEYS = {
  home: { blocked: [], agents: [], needs_items: [], lanes: [] },
  lanes: { lanes: [] },
  plan: { tracks: [], plan: null, milestones: [] },
  jobs: { jobs: [] },
  agents: { agents: [] },
  agent: {},
  log: { entries: [] },
  channels: { channels: [], who: null, now: null, log: [], selected: null },
  decisions: { decisions: [] },
  recall: { entries: [], results: [] },
  settings: {},
  slots: { slots: [] },
  audit: {},
  huddle: { participants: [], replies: [] },
  job: {},
  needs: { items: [], count: 0, stale: [] },
};
const fresh = (v) => (Array.isArray(v) ? [] : v && typeof v === 'object' ? { ...v } : v);
/** Fill the lists a view indexes without a guard. Keeps every field the server sent, including __status and __stale. */
export function withDefaults(what, reply) {
  const d = reply && typeof reply === 'object' ? reply : {};
  const want = KEYS[what] || {};
  for (const k of Object.keys(want)) if (d[k] == null || (Array.isArray(want[k]) && !Array.isArray(d[k]))) d[k] = fresh(want[k]);
  return d;
}
/** One envelope for new code: {ok, stale, error, data}. No raw status codes reach the view. */
export function envelope(what, reply) {
  const d = withDefaults(what, reply);
  const status = d.__status == null ? 200 : d.__status;
  return { ok: status >= 200 && status < 300 && !d.__stale, stale: !!d.__stale, error: status >= 300 ? (d.error || 'Could not load this view.') : null, data: d };
}
/** Why a reply cannot be used, or null. A reply must be a plain object, carry a matching contract version when it names one, and send arrays where lists belong. */
export function contractProblem(what, reply) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return 'LogMem sent a reply this page cannot read.';
  const v = reply.contract != null ? reply.contract : reply.__contract;
  if (v != null && Number(v) !== CONTRACT) return 'This page and the LogMem server do not match. Reload the page.';
  const want = KEYS[what] || {};
  for (const k of Object.keys(want)) if (Array.isArray(want[k]) && reply[k] != null && !Array.isArray(reply[k])) return 'LogMem sent a reply this page cannot read.';
  return null;
}
/** The reply a view gets when the network or the contract fails: safe defaults, marked stale, never a throw. */
export function failed(what, error) {
  const data = withDefaults(what, {});
  return Object.assign({}, data, { ok: false, stale: true, error, data, __status: 0, __stale: true });
}
