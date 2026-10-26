// sync.mjs — Coordination Sync Contract: runs, daily slots, concurrency, crash recovery, and receipts.
// Spec: docs/superpowers/specs/2026-10-22-coordination-sync-claude-response.md (PR D, Cases 18-25, 27, 29-33).

import { createHash } from "node:crypto";
import {
  listOpenCoordItemsForAgent,
  readCoordCoverage,
} from "./coord.mjs";

export const SLOTS = ["morning", "midday", "closeout", "manual"];
export const LEASE_TTL_SEC = 120; // 120-second TTL for receipt lease

export function syncRunKey(space, agent, runId) {
  const norm = String(agent || "").replace(/^agent:/, "");
  return `lm:${space}:sync:run:${norm}:${runId}`;
}

export function syncSlotKey(space, agent, date, slot) {
  const norm = String(agent || "").replace(/^agent:/, "");
  return `lm:${space}:sync:slot:${norm}:${date}:${slot}`;
}

export function syncLeaseKey(space, agent) {
  const norm = String(agent || "").replace(/^agent:/, "");
  return `lm:${space}:sync:lease:${norm}`;
}

export function coordActionKey(space, actionId) {
  return `lm:${space}:coord:action:${actionId}`;
}

/**
 * Computes a stable hash-based run ID if none provided.
 */
export function mintRunId(space, agent, ts = Date.now()) {
  const norm = String(agent || "").replace(/^agent:/, "");
  const h = createHash("sha256").update(`${space}|${norm}|${ts}|${Math.random()}`).digest("hex");
  return `sync_${h.slice(0, 24)}`;
}

/**
 * Action ID for answering notes to prevent replay / double answering.
 */
export function computeActionId(runId, itemId, disposition) {
  const h = createHash("sha256").update(`${runId}|${itemId}|${disposition}`).digest("hex");
  return `act_${h.slice(0, 24)}`;
}

/**
 * Gets local date string (YYYY-MM-DD) in America/New_York.
 */
export function getLocalSlotDate(ts = Date.now(), timeZone = "America/New_York") {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/**
 * Returns the expected slot based on local time in America/New_York:
 * - morning: 06:00 - 11:30 (target 09:00)
 * - midday:  11:30 - 15:30 (target 13:00)
 * - closeout: 15:30 - 22:00 (target 17:30)
 * - manual: otherwise
 */
export function getSlotForTime(ts = Date.now(), timeZone = "America/New_York") {
  try {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(d);

    const h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const m = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    const timeNum = h + m / 60;

    if (timeNum >= 6 && timeNum < 11.5) return "morning";
    if (timeNum >= 11.5 && timeNum < 15.5) return "midday";
    if (timeNum >= 15.5 && timeNum <= 22) return "closeout";
    return "manual";
  } catch (_) {
    return "manual";
  }
}

/**
 * Validates whether the timestamp is within the window of the given slot.
 * A missed morning run cannot become a claimed success during closeout (Case 22).
 */
export function isTimeInSlotWindow(ts, slot, timeZone = "America/New_York") {
  if (!slot || slot === "manual") return true;
  const currentSlot = getSlotForTime(ts, timeZone);
  return currentSlot === slot;
}

/**
 * Reads a sync run record from Redis.
 */
export async function getSyncRun(store, space, agent, runId) {
  const raw = await store.redis("GET", syncRunKey(space, agent, runId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Acquires the 120s receipt lease.
 */
export async function acquireSyncLease(store, space, agent, token, ttlSec = LEASE_TTL_SEC) {
  const k = syncLeaseKey(space, agent);
  const res = await store.redis("SET", k, token, "NX", "EX", ttlSec);
  return res === "OK" || res === true;
}

/**
 * Verifies if the token still holds the active lease.
 */
export async function verifySyncLease(store, space, agent, token) {
  const k = syncLeaseKey(space, agent);
  const current = await store.redis("GET", k);
  return current === token;
}

/**
 * Releases the sync lease safely (only if token matches).
 */
export async function releaseSyncLease(store, space, agent, token) {
  const k = syncLeaseKey(space, agent);
  const current = await store.redis("GET", k);
  if (current === token) {
    await store.redis("DEL", k);
    return true;
  }
  return false;
}

/**
 * Claims an action ID (deduplication of replies/answers).
 */
export async function claimCoordAction(store, space, actionId) {
  const k = coordActionKey(space, actionId);
  const res = await store.redis("SET", k, "1", "NX", "EX", 86400);
  return res === "OK" || res === true;
}

/**
 * Executes logmem_sync.
 * Case 18: Pure read when receipt is false/omitted.
 * Case 19-23, Probes 29-33: Receipt recording, slot updating, crash recovery, and lease protection.
 */
export async function executeSync(store, {
  agent,
  receipt = false,
  run_id,
  slot,
  outcome,
  notes,
  claim_only = false,
  force_recovery = false,
  now = Date.now,
}) {
  const space = store.space;
  const normAgent = String(agent || "").replace(/^agent:/, "");
  const nowTs = typeof now === "function" ? now() : Number(now || Date.now());

  // 1. Load pending coordination items for the agent
  const openItems = await listOpenCoordItemsForAgent(store, space, normAgent);

  const pendingWithMeta = openItems.map((item) => {
    const isOverdue = nowTs > item.deadline;
    return {
      ...item,
      overdue: isOverdue,
      overdue_ms: isOverdue ? nowTs - item.deadline : 0,
    };
  });

  const coverage = await readCoordCoverage(store.redis, space);

  const counts = {
    total: pendingWithMeta.length,
    overdue: pendingWithMeta.filter((i) => i.overdue).length,
    handoffs: pendingWithMeta.filter((i) => i.type === "handoff").length,
    seats: pendingWithMeta.filter((i) => i.type === "seat").length,
    directed: pendingWithMeta.filter((i) => !["handoff", "seat"].includes(i.type)).length,
  };

  // ─── Mode 1: Read-Only (Case 18) ──────────────────────────────────
  if (!receipt) {
    return {
      ok: true,
      agent: normAgent,
      run_id: run_id || mintRunId(space, normAgent, nowTs),
      pending: pendingWithMeta,
      counts,
      coverage,
      instructions:
        "Answer actionable items using logmem_accept or logmem_note with answers. Then call logmem_sync with receipt=true to record your run.",
    };
  }

  // ─── Mode 2: Receipt Mode (Cases 19-25, Probes 29-33) ──────────────
  const runId = run_id || mintRunId(space, normAgent, nowTs);
  const targetSlot = slot || getSlotForTime(nowTs);
  const localDate = getLocalSlotDate(nowTs);

  const runKey = syncRunKey(space, normAgent, runId);
  const slotKey = syncSlotKey(space, normAgent, localDate, targetSlot);

  // Check if run record already exists
  const existingRun = await getSyncRun(store, space, normAgent, runId);

  // Probe 30: Retry of an already completed run returns the existing receipt (idempotency)
  if (existingRun && existingRun.status === "complete") {
    return {
      ok: true,
      run_id: runId,
      receipt: existingRun,
      deduped: true,
    };
  }

  // Window validation (Case 22):
  // Check if targetSlot window matches current time. Attempt outside window cannot pass.
  const inWindow = isTimeInSlotWindow(nowTs, targetSlot);
  let resolvedOutcome = outcome;
  if (!resolvedOutcome) {
    if (!inWindow && targetSlot !== "manual") {
      resolvedOutcome = "missed";
    } else {
      resolvedOutcome = pendingWithMeta.length === 0 ? "pass" : "partial";
    }
  } else if (!inWindow && targetSlot !== "manual" && resolvedOutcome === "pass") {
    resolvedOutcome = "missed";
  }

  // Probe 31 & 32 & Case 23: Crash Recovery
  // If existing record was 'claimed', or if force_recovery is flagged
  const isRecovery = (existingRun && existingRun.status === "claimed") || force_recovery;

  // Probe 33: Lease check
  // Acquire or verify lease
  const leaseToken = "lease_" + nowTs + "_" + Math.random().toString(36).slice(2, 8);
  let hasLease = false;

  if (isRecovery) {
    // During crash recovery, check if old lease is still active
    const oldLeaseToken = existingRun?.lease_token;
    if (oldLeaseToken) {
      const stillActive = await verifySyncLease(store, space, normAgent, oldLeaseToken);
      if (stillActive) {
        // Runner crashed, same runner or retry reclaiming
        hasLease = true;
      }
    }
    if (!hasLease) {
      hasLease = await acquireSyncLease(store, space, normAgent, leaseToken);
    }
  } else {
    hasLease = await acquireSyncLease(store, space, normAgent, leaseToken);
  }

  // If claim_only is requested (simulating crash after claim, Probe 32)
  if (claim_only) {
    const claimRecord = {
      run_id: runId,
      agent: normAgent,
      space,
      slot: targetSlot,
      date: localDate,
      status: "claimed",
      lease_token: leaseToken,
      started_at: nowTs,
      recovered: false,
    };
    await store.redis("SET", runKey, JSON.stringify(claimRecord), "EX", 86400 * 7);
    return {
      ok: true,
      run_id: runId,
      status: "claimed",
      claimed: true,
    };
  }

  // If runner could not acquire lease, verify whether lease expired or owned by another runner (Case 25, Probe 33)
  if (!hasLease) {
    if (existingRun?.lease_token) {
      const stillActive = await verifySyncLease(store, space, normAgent, existingRun.lease_token);
      if (!stillActive) {
        throw new Error(`cannot complete sync run: lease for agent '${normAgent}' expired`);
      }
    } else {
      throw new Error(`cannot start sync run: concurrent sync lease held for agent '${normAgent}'`);
    }
  }

  const runRecord = {
    run_id: runId,
    agent: normAgent,
    space,
    slot: targetSlot,
    date: localDate,
    status: "complete",
    outcome: resolvedOutcome,
    recovered: !!isRecovery,
    in_window: inWindow,
    started_at: existingRun?.started_at || nowTs,
    completed_at: nowTs,
    pending_count: pendingWithMeta.length,
    overdue_count: counts.overdue,
    coverage,
    notes: notes || undefined,
  };

  // 1. Save immutable run record
  await store.redis("SET", runKey, JSON.stringify(runRecord), "EX", 86400 * 30);

  // 2. Append attempt to daily slot list/zset
  const attemptSummary = JSON.stringify({
    run_id: runId,
    at: nowTs,
    outcome: resolvedOutcome,
    recovered: !!isRecovery,
  });
  await store.redis("RPUSH", slotKey, attemptSummary);

  // 3. Release lease
  await releaseSyncLease(store, space, normAgent, leaseToken);

  return {
    ok: true,
    run_id: runId,
    slot: targetSlot,
    receipt: runRecord,
  };
}

/**
 * Builds the slots view for an agent and local date.
 * Case 27: Three-run state per roster agent with exceptions.
 */
export async function getAgentSlotsView(store, space, agent, date, nowTs = Date.now()) {
  const normAgent = String(agent || "").replace(/^agent:/, "");
  const localDate = date || getLocalSlotDate(nowTs);

  const slotResults = {};
  const scheduledSlots = ["morning", "midday", "closeout"];

  for (const s of scheduledSlots) {
    const slotKey = syncSlotKey(space, normAgent, localDate, s);
    const rawAttempts = await store.redis("LRANGE", slotKey, 0, -1);
    const attempts = (rawAttempts || []).map((str) => {
      try {
        return JSON.parse(str);
      } catch (_) {
        return { raw: str };
      }
    });

    // Evaluate state: pass (verified receipt), partial, failed, missed, disabled, etc.
    let state = "unknown";
    if (attempts.length === 0) {
      // Compare the requested local day before checking today's slot windows.
      const today = getLocalSlotDate(nowTs);
      const currentSlot = getSlotForTime(nowTs);
      const hour = Number(new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "numeric", hourCycle: "h23",
      }).format(new Date(nowTs)));
      const afterCloseout = currentSlot === "manual" && hour >= 22;
      const isPast = localDate < today || (localDate === today && (
        afterCloseout ||
        (s === "morning" && (currentSlot === "midday" || currentSlot === "closeout")) ||
        (s === "midday" && currentSlot === "closeout")
      ));
      state = isPast ? "missed" : "pending";
    } else {
      const last = attempts[attempts.length - 1];
      state = last.outcome || "unknown";
    }

    slotResults[s] = {
      slot: s,
      state,
      attempts,
    };
  }

  return {
    agent: normAgent,
    date: localDate,
    slots: slotResults,
  };
}
