// data.js — the one door between views and the backend. Views call load() or read(); they do not call api() directly.
// load(what, extra): the reply with defaults filled, same shape the views already use (ok(d) keeps working).
// read(what, extra): {ok, stale, error, data}. A thrown network error becomes {ok:false, error}.
import { api } from './core.js';
import { withDefaults, envelope, KEYS, CONTRACT } from './data-defaults.js';
export { KEYS, CONTRACT };
export async function load(what, extra) { return withDefaults(what, await api(what, extra)); }
export async function read(what, extra) {
  try { return envelope(what, await api(what, extra)); }
  catch (e) { return { ok: false, stale: false, error: e && e.message ? e.message : 'Could not reach LogMem.', data: withDefaults(what, {}) }; }
}
