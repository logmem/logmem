// phase-timer.mjs — name the step that stalls a signed-in request.
//
// Outage prod-api-timeout-20261120: signed-in /api/pulse, /api/needs,
// /api/view and /api/interactions hit the Vercel limit (15s / 30s) with no
// app log at all. A log written after the step never runs when the platform
// kills the task, so each timed step also arms a timer. If the step is still
// running at slowMs, one "still running" line names it before the kill.
//
// Log volume stays low: a finished step logs only when it took slowMs or more,
// or when LOGMEM_PHASE_TIMERS=1 (log every step). Lines carry phase names and
// milliseconds only, never a key, token, user id or value.

const DEFAULT_SLOW_MS = 2000;

function emit(line, log) {
  (log || console.log)(JSON.stringify({ ts: new Date().toISOString(), route: "phase-timer", ...line }));
}

/**
 * Run fn() as one named step.
 * @param {string} phase   short step name, e.g. "clerk.authenticateRequest"
 * @param {() => Promise<any>} fn
 * @param {{env?:object, slowMs?:number, log?:Function, now?:() => number}} opts
 */
export async function timed(phase, fn, opts = {}) {
  const env = opts.env || process.env;
  const slowMs = Number(opts.slowMs ?? env.LOGMEM_PHASE_SLOW_MS) || DEFAULT_SLOW_MS;
  const now = opts.now || (() => performance.now());
  const all = env.LOGMEM_PHASE_TIMERS === "1";
  const t0 = now();
  const timer = setTimeout(() => emit({ level: "warn", phase, still_running_ms: slowMs }, opts.log), slowMs);
  timer.unref?.();
  let ok = true;
  try {
    return await fn();
  } catch (e) {
    ok = false;
    throw e;
  } finally {
    clearTimeout(timer);
    const ms = Math.round(now() - t0);
    if (all || ms >= slowMs) emit({ level: ms >= slowMs ? "warn" : "info", phase, ms, ok }, opts.log);
  }
}
