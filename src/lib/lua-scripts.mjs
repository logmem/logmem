// lua-scripts.mjs — registry of Lua scripts that callers send with EVAL.
//
// Production modules (the ACMI cloud control plane) register each script's
// source with a synchronous JS equivalent. Real Redis runs the Lua text; the
// in-memory emulator (memory-redis.mjs) looks the source up here and runs the
// JS body against its own map, which gives the same atomicity in tests.
// Neutral on purpose: production code depends on this, not on the test double.

const scripts = new Map();

/** Register `fn(call, keys, argv)` as the in-process equivalent of Lua `source`. */
export function registerEvalScript(source, fn) {
  scripts.set(String(source), fn);
}

/** The registered equivalent for `source`, or undefined. */
export function evalScriptFor(source) {
  return scripts.get(String(source));
}
