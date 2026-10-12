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

export const config = { runtime: "nodejs", maxDuration: 30 };

export async function buildScorecard(redis, space) {
  const store = createStore(readOnly(redis), { space });
  const checks = (await store.readLog("job", CHECK_JOB, { sinceMs: Date.now() - 30 * 864e5 })).filter((e) => e.kind === "checkup" && e.payload?.date);
  let card = null;
  for (const e of checks) card = updateScorecard(card, { day: e.payload, deliverable: null }, new Date(e.ts).toISOString());
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
  try {
    const space = String(req.query?.space || "madez").toLowerCase();
    if (!/^[a-z0-9_-]{1,60}$/.test(space)) return res.status(400).json({ error: "bad space" });
    const d = descriptorFromEnv();
    if (!d) return res.status(503).json({ error: "scorecard backend not configured on this deployment" });
    res.status(200).json(await buildScorecard(fromDescriptor(d).redis, space));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
