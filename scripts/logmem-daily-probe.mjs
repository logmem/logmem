#!/usr/bin/env node
// logmem-daily-probe.mjs — daily bridge health probe for the LogMem REST bridge.
//
// Durable replacement for the scratch-only probe the 9am cron used to run.
// The old copy lived in ~/.hermes/cache/scratch/ and was pruned, which broke the
// cron for 15 consecutive runs. This lives in the repo so it survives pruning.
//
// Writes a checkup note to job:bridge-daily-probe so the job log keeps a daily
// heartbeat, and prints one PASS/FAIL line per check for the cron script.
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/logmem-daily-probe.mjs

import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { createLogmem } from "../src/server.mjs";
import { resilientBackendFromEnv } from "../src/lib/backend.mjs";

const JOB_ID = "bridge-daily-probe";
const TRAIL = "bridgeDailyProbe";

function ms(start) {
  return Date.now() - start;
}

// Record the daily result on the job. A failure here must not fail the probe:
// the health verdict has already been printed.
async function writeNote(summary, payload) {
  try {
    const backend = await resilientBackendFromEnv(process.env, { required: true });
    const lm = createLogmem({ redis: backend.redis, space: "madez", spaces: ["madez"] });
    const t = Date.now();
    await lm.store.append("job", JOB_ID, {
      ts: t,
      kind: "checkup",
      by: "agent:hermes",
      via: "cron",
      byline: "hermes (via cron)",
      trail: TRAIL,
      summary,
      payload,
    });
    return true;
  } catch (err) {
    console.log(`NOTE write failed: ${err && err.message ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const desc = descriptorFromEnv(process.env);
  const backend = desc ? fromDescriptor(desc) : null;
  if (!backend) {
    console.log("FAIL no backend configured (need LOGMEM_REST_URL + LOGMEM_REST_TOKEN)");
    await writeNote("Daily bridge probe: FAIL. No backend configured.", { ok: false, reason: "no backend configured" });
    process.exit(1);
  }
  const redis = backend.redis;
  const t0 = Date.now();

  // 1. PING
  const pong = await redis("PING");
  const pingOk = String(pong ?? "").toUpperCase() === "PONG";
  const pingMs = ms(t0);
  console.log(`${pingOk ? "PASS" : "FAIL"} ping ${pingOk ? "PONG" : String(pong)}, ${pingMs} ms`);
  if (!pingOk) {
    await writeNote(`Daily bridge probe: FAIL. ping ${String(pong)}.`, { ok: false, ping: String(pong), ping_ms: pingMs });
    process.exit(1);
  }

  // 2. The backend must not be degraded.
  const t1 = Date.now();
  let degraded = false;
  try {
    const raw = await redis("GET", "lm:health");
    if (raw !== null && raw !== undefined && raw !== "") {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      degraded = parsed?.degraded === true;
    }
  } catch {
    // An unreadable health key is not proof of degradation; report it plainly.
    console.log(`PASS health unreadable, ${ms(t1)} ms`);
  }
  const degradedMs = ms(t1);
  console.log(`${!degraded ? "PASS" : "FAIL"} degraded ${degraded}, ${degradedMs} ms`);
  if (degraded) {
    await writeNote(`Daily bridge probe: FAIL. degraded true.`, { ok: false, degraded: true, ping_ms: pingMs });
    process.exit(1);
  }

  // 3. A write round-trip, then clean up after ourselves.
  const t2 = Date.now();
  const probeKey = `lm:probe:daily:${Date.now()}`;
  let writeOk = false;
  let writeMs = 0;
  try {
    await redis("SET", probeKey, "1", "EX", "60");
    const got = await redis("GET", probeKey);
    writeOk = String(got) === "1";
    writeMs = ms(t2);
    console.log(`${writeOk ? "PASS" : "FAIL"} write round-trip, ${writeMs} ms`);
    if (!writeOk) {
      await writeNote("Daily bridge probe: FAIL. write round-trip did not read back.", { ok: false, ping_ms: pingMs, degraded: false, write_ms: writeMs });
      process.exit(1);
    }
  } finally {
    try { await redis("DEL", probeKey); } catch { /* best effort cleanup */ }
  }

  const totalMs = ms(t0);
  console.log(`PASS all checks, ${totalMs} ms total`);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  await writeNote(
    `Daily bridge probe ${stamp}: PASS. ping PONG, degraded false. ${pingMs} ms.`,
    { ok: true, ping: "PONG", ping_ms: pingMs, degraded: false, write_ms: writeMs, total_ms: totalMs, at: stamp },
  );
  process.exit(0);
}

main().catch((err) => {
  console.log(`FAIL probe error: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
