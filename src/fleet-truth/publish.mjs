import { scrubSecrets } from "./schema.mjs";

const CHANNEL = "fleet-truth";
const BY = "agent:fleet-truth";
const VIA = "fleet-truth-runner";
const BYLINE = "fleet-truth (via fleet-truth-runner)";

export async function ensureWho(store, { nowMs } = {}) {
  const who = scrubSecrets({
    schema: "fleet-truth/v1",
    purpose: "Birds-eye source of truth for what is true now in this space, with evidence on every claim.",
    owner: "agent:fleet-truth",
    cadence: "America/New_York 09:00 morning, 13:00 midday, 17:00 closeout",
    hard_rules: [
      "No secrets, tokens, keys, or email addresses",
      "Scheduler-only Now writes after bootstrap seed",
      "Partial publish on probe failure; never invent",
    ],
    updated_at: nowMs ? new Date(nowMs).toISOString() : new Date().toISOString(),
  });
  await store.setWho("channel", CHANNEL, who);
  return who;
}

function deltaLine(board) {
  const items = board?.deltas?.items || [];
  if (!items.length) return "no material change";
  return items[0].claim || "no material change";
}

/**
 * Overwrite channel Now, append checkup on fleet-truth, pointer memo on agent-coordination.
 */
export async function publishBoard(store, { summary, now, trail, nowMs, seedWho = false } = {}) {
  if (seedWho) await ensureWho(store, { nowMs });
  const cleanSummary = scrubSecrets(String(summary || ""));
  const cleanBoard = scrubSecrets(now);
  const fields = {
    summary: cleanSummary,
    board: cleanBoard,
    refreshed_at: cleanBoard.refreshed_at || new Date(nowMs).toISOString(),
    slot: cleanBoard.slot,
    trail,
    updated_at: nowMs,
  };
  if (typeof store.replaceNow === "function") await store.replaceNow("channel", CHANNEL, fields);
  else {
    // fallback: field overwrite merge
    await store.setNow("channel", CHANNEL, fields);
  }

  const checkup = await store.append("channel", CHANNEL, {
    ts: nowMs,
    kind: "checkup",
    by: BY,
    via: VIA,
    byline: BYLINE,
    trail,
    summary: cleanSummary.slice(0, 1000),
    payload: { schema: cleanBoard.schema, slot: cleanBoard.slot, deltas: cleanBoard.deltas?.items?.map((d) => d.claim) },
  });

  const pointerSummary = scrubSecrets(
    `fleet-truth ${cleanBoard.slot} refresh ${trail}: ${deltaLine(cleanBoard)}`,
  ).slice(0, 1000);

  const pointer = await store.append("channel", "agent-coordination", {
    ts: nowMs,
    kind: "memo",
    by: BY,
    via: VIA,
    byline: BYLINE,
    trail,
    summary: pointerSummary,
    payload: { channel: "channel:fleet-truth", slot: cleanBoard.slot },
  });

  return { trail, checkup_ts: checkup.ts, pointer_ts: pointer.ts };
}
