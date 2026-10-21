// apply-limits.mjs — wrap a store with a managed account's plan limits.
//
// The limits themselves (src/http/limits.mjs createLimits) use the hosted meter
// in cloud/. This wrapper has no imports, so the stdio server and the npm
// package can apply limits without shipping cloud/. Limits are off (null) for
// the fleet and self-hosted.

/** Apply limits to a store in place: every append is checked, every log read gets the history floor. */
export function applyLimits(store, limits) {
  if (!limits) return store;
  const append = store.append.bind(store);
  const readLog = store.readLog.bind(store);
  const getRecap = store.getRecap.bind(store);
  store.append = async (ns, id, entry) => {
    const commit = await limits.beforeWrite(entry);
    const out = await append(ns, id, entry);
    await commit();
    return out;
  };
  store.readLog = async (ns, id, opts = {}) => {
    const floor = limits.historyFloorMs();
    if (floor == null) return readLog(ns, id, opts);
    const sinceMs = opts.sinceMs != null ? Math.max(Number(opts.sinceMs), floor) : floor;
    return readLog(ns, id, { ...opts, sinceMs });
  };
  store.getRecap = async (agent) => {
    const r = await getRecap(agent);
    const floor = limits.historyFloorMs();
    if (!r || floor == null) return r;
    const at = Number(r.updated_at ?? r.ended_at ?? 0);
    return at >= floor ? r : null;
  };
  return store;
}
