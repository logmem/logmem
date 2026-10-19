// web-store.mjs — the store the web app writes through when a person acts.
//
// Writes by a person (a decision, a blocker step) must reach ACMI too in a
// mirrored space, or the dogfood check counts each one as a mirror mismatch
// and fails the day. This builds the same store the MCP server uses: with
// the ACMI mirror when LOGMEM_MIRROR_ACMI covers the space.

import { createStore } from "../core/store.mjs";
import { createMirror, mirrorConfigFromEnv } from "../core/mirror.mjs";

export function webStore(redis, space, env = process.env) {
  const cfg = mirrorConfigFromEnv(env);
  const mirrorOn = !!cfg.enabled && (cfg.spaces || []).includes(space);
  return createStore(redis, { space, mirror: mirrorOn ? createMirror(redis, space) : null });
}
