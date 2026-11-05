import { randomUUID } from "node:crypto";
import { createStore } from "../core/store.mjs";
import { createMirror } from "../core/mirror.mjs";
import { CORE_AGENTS } from "./core.mjs";
import { collectObservations } from "./collect.mjs";
import { buildBoard } from "./build.mjs";
import { publishBoard } from "./publish.mjs";
import { slotFor, etDate, trailId } from "./slot.mjs";

export const RUNNER = "agent:fleet-truth";

export function lockKey(space, dateEt, slot) {
  return `lm:${space}:fleet-truth:lock:${dateEt}:${slot}`;
}

function parseProbes(probes) {
  if (Array.isArray(probes)) return probes;
  if (typeof probes === "string" && probes.trim()) {
    try {
      const v = JSON.parse(probes);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return undefined;
}

/**
 * One fleet-truth refresh. When slot is omitted, uses slotFor(nowMs); null → skipped.
 */
export async function runOnce(redis, {
  space = "madez",
  nowMs = Date.now(),
  slot: forcedSlot,
  dry = false,
  probes,
  seedWho = false,
  coreAgents = CORE_AGENTS,
  fetchImpl,
  lockTtlS = 600,
  mirror = false,
} = {}) {
  const slot = forcedSlot || slotFor(nowMs);
  if (!slot) return { ok: true, skipped: "not_a_slot", space };

  const dateEt = etDate(nowMs);
  const trail = trailId(dateEt, slot);
  const key = lockKey(space, dateEt, slot);
  const token = randomUUID();

  if (!dry) {
    if ((await redis("SET", key, token, "NX", "EX", String(lockTtlS))) == null) {
      return { ok: true, skipped: "locked", space, trail };
    }
  }

  let published = false;
  try {
    const store = createStore(redis, {
      space,
      compat: false,
      mirror: mirror ? createMirror(redis, space) : null,
    });
    const previousBoard = (await store.getNow("channel", "fleet-truth"))?.board || null;
    const { observations } = await collectObservations(store, {
      nowMs,
      coreAgents,
      probes: parseProbes(probes),
      fetchImpl,
    });
    const built = buildBoard({
      observations,
      previous: previousBoard,
      nowMs,
      slot,
      runner: RUNNER,
    });
    // Keep trail aligned with forced/manual slot (buildBoard also computes one).
    built.now.trail = trail;
    built.now.slot = slot;

    if (dry) return { ok: true, dry: true, space, trail, summary: built.summary, now: built.now };

    await publishBoard(store, {
      summary: built.summary,
      now: built.now,
      trail,
      nowMs,
      seedWho,
    });
    published = true;
    return { ok: true, space, trail, summary: built.summary };
  } finally {
    // After a successful publish, keep the slot lock until TTL so a duplicate
    // cron delivery cannot double-append. Release early only on failure.
    if (!dry && !published) {
      try {
        if ((await redis("GET", key)) === token) await redis("DEL", key);
      } catch {
        // lock expires on its own
      }
    }
  }
}
