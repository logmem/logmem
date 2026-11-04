#!/usr/bin/env node
// CLI: node scripts/fleet-truth.mjs --space madez [--slot morning|midday|closeout|manual] [--dry] [--seed] [--now ISO]
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { runOnce } from "../src/fleet-truth/run.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const flag = (n) => argv.includes(`--${n}`);

const space = arg("space", "madez");
const slot = arg("slot", null);
const dry = flag("dry");
const seedWho = flag("seed");
const nowIso = arg("now", null);
const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
const probes = process.env.LOGMEM_FLEET_TRUTH_PROBES;

if (Number.isNaN(nowMs)) {
  console.error("bad --now ISO timestamp");
  process.exit(1);
}

const d = descriptorFromEnv();
if (!d) {
  console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
  process.exit(1);
}
const redis = fromDescriptor(d).redis;
const out = await runOnce(redis, {
  space,
  nowMs,
  slot: slot || undefined,
  dry,
  seedWho,
  probes,
  mirror: space === "madez",
});
console.log(JSON.stringify(out, null, 2));
if (out.skipped === "locked") process.exit(2);
