// data.js — the one door between views and the backend. Views call load() or read(); they do not call api() directly.
// load(what, extra): the reply with defaults filled, same shape the views already use (ok(d) keeps working).
// read(what, extra): {ok, stale, error, data}. A thrown network error becomes {ok:false, error}.
import { api, getJSON } from './core.js';
import { interpret, ENDPOINTS } from './endpoint-model.js';
import { withDefaults, envelope, contractProblem, failed, KEYS, CONTRACT } from './data-defaults.js';
export { KEYS, CONTRACT };
export async function load(what, extra) {
  let reply;
  try { reply = await api(what, extra); }
  catch (e) { return failed(what, e && e.message ? e.message : 'Could not reach LogMem.'); }
  const bad = contractProblem(what, reply);
  if (bad) return failed(what, bad);
  return withDefaults(what, reply);
}
export async function read(what, extra) {
  try { const reply = await api(what, extra); const bad = contractProblem(what, reply); return bad ? { ok: false, stale: true, error: bad, data: withDefaults(what, {}) } : envelope(what, reply); }
  catch (e) { return { ok: false, stale: false, error: e && e.message ? e.message : 'Could not reach LogMem.', data: withDefaults(what, {}) }; }
}
/** read one planned endpoint (integrations, usage, sessions, platform): {ok, available, stale, error, data}. Never throws. */
export async function readEndpoint(key) {
  try { const r = await getJSON(ENDPOINTS[key].url); if (r.__stale) return { ok: false, available: true, stale: true, error: null, data: ENDPOINTS[key].defaults() }; return interpret(key, r.__status, r); }
  catch (e) { return { ok: false, available: true, stale: false, error: 'Could not reach LogMem.', data: ENDPOINTS[key].defaults() }; }
}
