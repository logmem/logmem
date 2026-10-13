// GET /api/scorecard?space=madez — the dogfood scorecard.
//
// Source, in order:
//   1. the scorecard the daily check stores in Redis (lm:{space}:dogfood:scorecard,
//      written by api/cron/dogfood-check.mjs or scripts/dogfood-check.mjs);
//   2. the checkup entries on lm:{space}:job:logmem-dogfood:log (the old source).
// Both are filtered by the same trust rule: a day counts only if a checkup for
// that date was written by agent:logmem-check. Every field is coerced, and the
// gate and the deliverable are always recomputed here, never taken from storage.
//
// The preview env holds read-write bridge creds (Mikey approved 2026-10-11);
// this endpoint wraps them in the read-only guard, so it cannot write.
// Preview deployments sit behind Vercel SSO.

import { createStore, tryParse } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { readOnly } from "../src/lib/read-only.mjs";
import { updateScorecard, gate, scorecardKey, CHECK_JOB, CHECK_BY, DELIVERABLE_JOB } from "../scripts/dogfood-check.mjs";
import { mayRead, viewSpaces } from "../src/http/admin-auth.mjs";
import { sendServerError } from "../src/http/log.mjs";

export const config = { runtime: "nodejs", maxDuration: 30 };

const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
export function cleanDay(p, space) {
  return {
    date: String(p.date).slice(0, 10), space, ran: true,
    pass: p.pass === true, health_pass: p.health_pass === true, volume_pass: p.volume_pass === true, mirror_checked: p.mirror_checked === true,
    agents: Array.isArray(p.agents) ? p.agents.map(String).slice(0, 50) : [],
    entries: N(p.entries), handoffs: N(p.handoffs), accepted: N(p.accepted), mirror_mismatches: N(p.mirror_mismatches),
    unanswered_24h: N(p.unanswered_24h), degraded_sessions: N(p.degraded_sessions), stuck_written: N(p.stuck_written), mismatch_examples: [],
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v) => {
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The Redis scorecard, or null if missing, malformed, or not written by the check. */
export async function readStoredScorecard(redis, space) {
  const raw = await redis("GET", scorecardKey(space));
  const card = typeof raw === "string" ? tryParse(raw) : null;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  if (card.by !== CHECK_BY || card.space !== space || !Array.isArray(card.days)) return null;
  return card;
}

export async function buildScorecard(redis, space) {
  const r = readOnly(redis);
  const store = createStore(r, { space });
  // Only checkups written by the audit itself count, and only their known
  // fields survive: anyone can write to a job log, so payloads are untrusted.
  const checks = (await store.readLog("job", CHECK_JOB, { sinceMs: Date.now() - 30 * 864e5 }))
    .filter((e) => e.kind === "checkup" && e.by === CHECK_BY && e.payload && DATE_RE.test(String(e.payload.date)));
  let card = null;
  for (const e of checks) card = updateScorecard(card, { day: cleanDay(e.payload, space), deliverable: null }, new Date(e.ts).toISOString());

  // Redis first: its rows replace the checkup-built rows date by date, but a
  // row is kept only when a trusted checkup exists for that date.
  let source = checks.length ? "checkups" : "none";
  const stored = await readStoredScorecard(r, space);
  if (stored) {
    const trusted = new Set(checks.map((e) => String(e.payload.date)));
    const rows = stored.days.filter((d) => d && typeof d === "object" && DATE_RE.test(String(d.date)) && trusted.has(String(d.date)));
    for (const d of rows) card = updateScorecard(card, { day: cleanDay(d, space), deliverable: null }, card?.generated_at);
    if (rows.length) {
      source = "redis";
      card.generated_at = isoOrNull(stored.generated_at) || card.generated_at;
    }
  }

  const deliverable = {
    job: DELIVERABLE_JOB,
    stage: (await store.getNow("job", DELIVERABLE_JOB)).stage || "missing",
    links: ((await store.getWho("job", DELIVERABLE_JOB)) || {}).links || [],
  };
  card = card || { space, days: [] };
  card.space = space;
  card.deliverable = deliverable;
  card.gate = gate(card);
  card.checks = checks.length;
  card.source = source;
  return card;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!mayRead(req)) return res.status(401).json({ error: "sign in required" });
  try {
    const space = String(req.query?.space || "madez").toLowerCase();
    if (!/^[a-z0-9_-]{1,60}$/.test(space)) return res.status(400).json({ error: "bad space" });
    if (!viewSpaces().includes(space)) return res.status(403).json({ error: "space not shown here" });
    const d = descriptorFromEnv();
    if (!d) return res.status(503).json({ error: "scorecard backend not configured on this deployment" });
    res.status(200).json(await buildScorecard(fromDescriptor(d).redis, space));
  } catch (e) {
    sendServerError(res, "/api/scorecard", e);
  }
}
