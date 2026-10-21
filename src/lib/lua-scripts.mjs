// lua-scripts.mjs — registry of Lua scripts that callers send with EVAL.
//
// Production modules (the ACMI cloud control plane) register each script's
// source with a synchronous JS equivalent. Real Redis runs the Lua text; the
// in-memory emulator (memory-redis.mjs) looks the source up here and runs the
// JS body against its own map, which gives the same atomicity in tests.
// Neutral on purpose: production code depends on this, not on the test double.

const scripts = new Map();
// Scripts a managed user's jailed connection may run (src/http/jail.mjs). Opt in only:
// the control-plane scripts (the meter) touch server keys and must never be reachable.
const jailSafe = new Set();

/**
 * Register `fn(call, keys, argv)` as the in-process equivalent of Lua `source`.
 * `{ jail: true }` marks a script that touches only the KEYS it is given, so the jail
 * may run it when every key is inside the user's space.
 */
export function registerEvalScript(source, fn, { jail = false } = {}) {
  scripts.set(String(source), fn);
  if (jail) jailSafe.add(String(source));
}

/** True when `source` is a LogMem script marked safe for a jailed connection. */
export function jailSafeScript(source) {
  return jailSafe.has(String(source));
}

/** Every jail-safe script, for the test that pins them to their KEYS. */
export function jailSafeScripts() {
  return [...jailSafe];
}

/** The registered equivalent for `source`, or undefined. */
export function evalScriptFor(source) {
  return scripts.get(String(source));
}
