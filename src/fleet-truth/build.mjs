import { buildSummary, emptyBoard, makeFact, SECTIONS, scrubSecrets } from "./schema.mjs";
import { trailId, etDate } from "./slot.mjs";
import { defaultClockClaims } from "./core.mjs";

export const FRESHNESS_MS = 36 * 3600e3;

const keyOf = (fact) => `${fact.claim}@@${fact.source}`;

function ageMs(fact, nowMs) {
  const t = Date.parse(fact.observed_at);
  return Number.isFinite(t) ? nowMs - t : Number.POSITIVE_INFINITY;
}

function carryPrevious(sectionItems, nowMs) {
  const out = [];
  for (const fact of sectionItems || []) {
    if (fact.status === "verified") {
      // Prior verified without a new observation becomes reported (not silently verified).
      out.push({ ...fact, status: "reported" });
      continue;
    }
    if (fact.status === "reported" && ageMs(fact, nowMs) > FRESHNESS_MS) {
      out.push({ ...fact, status: "stale" });
      continue;
    }
    out.push({ ...fact });
  }
  return out;
}

function infraRollup(items) {
  if (!items.length) return "unknown";
  if (items.some((f) => f.status === "unknown" || f.status === "stale")) return "degraded";
  if (items.every((f) => f.status === "verified" && /up|ok|healthy/i.test(f.claim))) return "ok";
  if (items.some((f) => f.status === "verified")) return "ok";
  return "unknown";
}

function p0FromLanes(items) {
  for (const f of items || []) {
    const m = String(f.claim).match(/P0=([^\s]+)/i);
    if (m) return m[1];
  }
  return "?";
}

function computeDeltas(prevSections, nextSections, nowMs) {
  const prevMap = new Map();
  const nextMap = new Map();
  for (const sec of SECTIONS) {
    if (sec === "deltas") continue;
    for (const f of prevSections?.[sec]?.items || []) prevMap.set(`${sec}:${keyOf(f)}`, f);
    for (const f of nextSections?.[sec]?.items || []) nextMap.set(`${sec}:${keyOf(f)}`, f);
  }
  const changes = [];
  for (const [k, nf] of nextMap) {
    const pf = prevMap.get(k);
    if (!pf) changes.push(`+ ${nf.claim}`);
    else if (pf.status !== nf.status) changes.push(`${nf.claim}: ${pf.status}->${nf.status}`);
  }
  for (const [k, pf] of prevMap) {
    if (!nextMap.has(k)) changes.push(`- ${pf.claim}`);
  }
  const observed_at = new Date(nowMs).toISOString();
  if (!changes.length) {
    return [makeFact({ claim: "no material change", status: "verified", observed_at, source: "fleet-truth:delta", verified_by: "agent:fleet-truth" })];
  }
  return changes.slice(0, 20).map((claim) =>
    makeFact({ claim, status: "verified", observed_at, source: "fleet-truth:delta", verified_by: "agent:fleet-truth" }),
  );
}

/**
 * @param {{ observations: Array<{section:string, fact:object}>, previous: object|null, nowMs:number, slot:string, runner:string }} args
 */
export function buildBoard({ observations, previous, nowMs, slot, runner }) {
  const refreshed_at = new Date(nowMs).toISOString();
  const trail = trailId(etDate(nowMs), slot);
  const board = emptyBoard({ refreshed_at, slot, runner, trail });

  // Start from carried previous (minus deltas).
  for (const sec of SECTIONS) {
    if (sec === "deltas") continue;
    board[sec].items = carryPrevious(previous?.[sec]?.items, nowMs);
  }

  // Seed clock defaults when empty.
  if (!board.clock.items.length) {
    board.clock.items = defaultClockClaims(nowMs);
  }

  // Apply observations: same claim+source replaces; never invent.
  const index = new Map();
  for (const sec of SECTIONS) {
    if (sec === "deltas") continue;
    for (let i = 0; i < board[sec].items.length; i++) {
      index.set(`${sec}:${keyOf(board[sec].items[i])}`, { sec, i });
    }
  }

  for (const obs of observations || []) {
    const sec = obs.section;
    if (!SECTIONS.includes(sec) || sec === "deltas") continue;
    const fact = scrubSecrets({ ...obs.fact });
    const k = `${sec}:${keyOf(fact)}`;
    const hit = index.get(k);
    if (hit) board[hit.sec].items[hit.i] = fact;
    else {
      board[sec].items.push(fact);
      index.set(k, { sec, i: board[sec].items.length - 1 });
    }
  }

  board.deltas.items = computeDeltas(previous, board, nowMs);

  const summary = buildSummary({
    refreshed_at,
    slot,
    p0: p0FromLanes(board.lanes.items),
    top_blocker: board.blockers.items[0]?.claim || "none",
    infra: infraRollup(board.infra.items),
  });

  return { summary, now: scrubSecrets(board) };
}
