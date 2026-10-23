// web-store.mjs — the store the web app writes through when a person acts.
//
// Writes by a person (a decision, a blocker step) must reach ACMI too in a
// mirrored space, or the dogfood check counts each one as a mirror mismatch
// and fails the day. This builds the same store the MCP server uses: with
// the ACMI mirror when LOGMEM_MIRROR_ACMI covers the space.
// Count each web entry through the same optional, count-only usage meter.

import { createStore } from "../core/store.mjs";
import { applyUsageMeter, createUsageMeter, meterOnFromEnv } from "../core/usage-meter.mjs";
import { createMirror, mirrorConfigFromEnv } from "../core/mirror.mjs";

export function webStore(redis, space, env = process.env) {
  const cfg = mirrorConfigFromEnv(env);
  const mirrorOn = !!cfg.enabled && (cfg.spaces || []).includes(space);
  const store = createStore(redis, { space, mirror: mirrorOn ? createMirror(redis, space) : null });
  const usage = meterOnFromEnv(env) ? createUsageMeter(redis, space) : null;
  return applyUsageMeter(store, usage);
}
