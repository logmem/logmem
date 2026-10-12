// GET /api/scorecard?space=madez — the dogfood scorecard, built live from the
// checkup entries on lm:{space}:job:logmem-dogfood:log.
//
// The preview env holds read-write bridge creds (Mikey approved 2026-10-11);
// this endpoint wraps them in the read-only guard, so it cannot write.
// Preview deployments sit behind Vercel SSO.

import { createStore } from "../src/core/store.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { readOnly } from "../src/lib/read-only.mjs";
import { updateScorecard, gate, CHECK_JOB, DELIVERABLE_JOB } from "../scripts/dogfood-check.mjs";
import { mayRead, viewSpaces } from "../src/http/admin-auth.mjs";

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

export async function buildScorecard(redis, space) {
  const store = createStore(readOnly(redis), { space });
  // Only checkups written by the audit itself count, and only their known
  // fields survive: anyone can write to a job log, so payloads are untrusted.
  const checks = (await store.readLog("job", CHECK_JOB, { sinceMs: Date.now() - 30 * 864e5 }))
    .filter((e) => e.kind === "checkup" && e.by === "agent:logmem-check" && e.payload && /^\d{4}-\d{2}-\d{2}$/.test(String(e.payload.date)));
  let card = null;
  for (const e of checks) card = updateScorecard(card, { day: cleanDay(e.payload, space), deliverable: null }, new Date(e.ts).toISOString());
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
    res.status(500).json({ error: e.message });
  }
}
