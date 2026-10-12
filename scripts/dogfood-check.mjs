#!/usr/bin/env node
// dogfood-check.mjs — the daily dogfood audit.
//
// For one space and one day (default: the 24h ending now):
//   - parity:   every lm log entry in the window has its ACMI twin (mirror spaces only)
//   - agents:   distinct agent writers
//   - handoffs: handoffs in the window, and how many were accepted
//               (LogMem "accepted" with origin=trail, or ACMI "handoff-ack" with parentCorrelationId=trail)
//   - stuck:    handoffs older than 24h with no accept -> writes one "stuck" entry each (once)
//   - degraded: self-reported (kind problem/alert with payload.degraded=true); in-memory
//               sessions never reach Redis, so self-report is the only signal
// Writes one "checkup" entry on job:logmem-dogfood and upserts the day into scorecard.json.
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/dogfood-check.mjs \
//     --space madez --scorecard docs/dogfood/scorecard.json [--mirror-spaces madez] [--dry]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createStore, tryParse, normTs } from "../src/core/store.mjs";
import { createMirror } from "../src/core/mirror.mjs";
import { acmiKey } from "../src/core/keys.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";

export const DAY_MS = 24 * 3600 * 1000;
export const CHECK_JOB = "logmem-dogfood";
export const DELIVERABLE_JOB = "logmem-v0-ship";
const BY = "agent:logmem-check";

async function scan(redis, pattern) {
  let cursor = "0";
  const out = new Set();
  do {
    const [next, batch] = await redis("SCAN", cursor, "MATCH", pattern, "COUNT", "1000");
    cursor = String(next);
    for (const k of batch) out.add(k);
  } while (cursor !== "0");
  return [...out].sort();
}

function parseLogKey(key, space) {
  const m = key.match(new RegExp(`^lm:${space}:([^:]+):([^:]+):log$`));
  return m ? { ns: m[1], id: m[2] } : null;
}

async function acmiRows(redis, key, from, to) {
  const flat = (await redis("ZRANGEBYSCORE", key, from, to, "WITHSCORES")) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push({ ...(tryParse(flat[i]) || {}), _score: normTs(flat[i + 1]) });
  return out;
}

export async function runCheck(redis, {
  space,
  mirrorSpaces = ["madez"],
  now = Date.now(),
  windowMs = DAY_MS,
  lookbackMs = 7 * DAY_MS,
  write = true,
} = {}) {
  const store = createStore(redis, { space, compat: false });
  const from = now - windowMs;
  const mirrored = mirrorSpaces.includes(space);
  const logKeys = (await scan(redis, `lm:${space}:*:log`)).map((k) => ({ key: k, ...parseLogKey(k, space) })).filter((x) => x.ns);

  const day = { date: new Date(now).toISOString().slice(0, 10), window: [from, now], ran: true, space, mirror_checked: mirrored, entries: 0, agents: [], mirror_mismatches: 0, mismatch_examples: [], degraded_sessions: 0, handoffs: 0, accepted: 0, unanswered_24h: 0, stuck_written: 0 };
  const agents = new Set();
  const handoffs = new Map(); // trail -> { ts, to, where, ns, id }
  const accepts = new Set(); // trails accepted (lm side)
  const stuckAlready = new Set();

  for (const { ns, id } of logKeys) {
    if (ns === "job" && id === CHECK_JOB) continue; // the audit log doesn't audit itself
    const recent = await store.readLog(ns, id, { sinceMs: now - lookbackMs, untilMs: now });
    for (const e of recent) {
      if (e.kind === "accepted" && e.origin) accepts.add(e.origin);
      if (e.kind === "stuck" && e.payload?.unanswered_handoff) stuckAlready.add(e.payload.unanswered_handoff);
      if (e.kind === "handoff" && e.trail && !handoffs.has(e.trail)) handoffs.set(e.trail, { ts: e.ts, to: e.to, where: e.job, ns, id });
      if (e.ts < from) continue;
      day.entries++;
      if (String(e.by || "").startsWith("agent:") && e.by !== BY) agents.add(e.by);
      if ((e.kind === "problem" || e.kind === "alert") && e.payload?.degraded) day.degraded_sessions++;
      if (mirrored && e.by !== BY) {
        const twins = await acmiRows(redis, acmiKey(space, ns, id, "log"), e.ts, e.ts);
        const ok = twins.some((t) => t.correlationId === e.trail && t.summary === e.summary);
        if (!ok) {
          day.mirror_mismatches++;
          if (day.mismatch_examples.length < 10) day.mismatch_examples.push({ log: `${ns}:${id}`, ts: e.ts, trail: e.trail });
        }
      }
    }
  }

  // ACMI-side accepts (VM agents answer with handoff-ack in acmi:* only).
  const acked = async (trail, h) => {
    if (accepts.has(trail)) return true;
    const keys = [acmiKey(space, "agent", String(h.to || "").replace(/^agent:/, ""), "log"), acmiKey(space, h.ns, h.id, "log")];
    for (const k of keys) {
      const rows = await acmiRows(redis, k, h.ts, "+inf");
      if (rows.some((r) => r.parentCorrelationId === trail && ["handoff-ack", "accepted"].includes(r.kind))) return true;
    }
    return false;
  };

  const stuckToWrite = [];
  for (const [trail, h] of handoffs) {
    const answered = await acked(trail, h);
    if (h.ts >= from) {
      day.handoffs++;
      if (answered) day.accepted++;
    }
    if (!answered && now - h.ts > DAY_MS) {
      day.unanswered_24h++;
      if (!stuckAlready.has(trail)) stuckToWrite.push({ trail, h });
    }
  }

  day.agents = [...agents].sort();
  day.health_pass = day.mirror_mismatches === 0 && day.degraded_sessions === 0 && day.unanswered_24h === 0;
  day.volume_pass = day.agents.length >= 3 && day.handoffs >= 1 && day.accepted >= day.handoffs;
  day.pass = day.health_pass && day.volume_pass;

  const deliverable = {
    job: DELIVERABLE_JOB,
    stage: (await store.getNow("job", DELIVERABLE_JOB)).stage || "missing",
    links: ((await store.getWho("job", DELIVERABLE_JOB)) || {}).links || [],
  };

  if (write) {
    const writer = createStore(redis, { space, mirror: mirrored ? createMirror(redis, space) : null });
    for (const { trail, h } of stuckToWrite) {
      await writer.append(h.ns, h.id, {
        ts: now, kind: "stuck", by: BY, via: "dogfood-check", byline: "logmem-check (via dogfood-check)",
        trail: `stuckHandoff-${now}`, origin: trail, summary: `Handoff to ${h.to} unanswered for more than 24h`,
        payload: { unanswered_handoff: trail },
      });
      day.stuck_written++;
    }
    await writer.append("job", CHECK_JOB, {
      ts: now, kind: "checkup", by: BY, via: "dogfood-check", byline: "logmem-check (via dogfood-check)",
      trail: `dogfoodCheck-${day.date}`, summary: `${day.date} ${day.pass ? "PASS" : "FAIL"}: ${day.agents.length} agents, ${day.entries} entries, ${day.handoffs} handoffs (${day.accepted} accepted), ${day.mirror_mismatches} mirror mismatches, ${day.unanswered_24h} unanswered >24h, ${day.degraded_sessions} degraded`,
      payload: day,
    });
  }
  return { day, deliverable };
}

/** Upsert a day into scorecard JSON (keeps the newest 30 days). */
export function updateScorecard(card, { day, deliverable }, generatedAt = new Date().toISOString()) {
  const days = (card?.days || []).filter((d) => d.date !== day.date);
  const { mismatch_examples, window, ...slim } = day;
  days.push({ ...slim, mismatch_examples });
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { generated_at: generatedAt, space: day.space, days: days.slice(-30), deliverable };
}

// Daily cron is 13:00 UTC (.github/workflows/dogfood-check.yml). Before that
// hour, yesterday is still a fresh newest day: today's run has not fired.
const CRON_HOUR_UTC = 13;

/** The 7-day bar. The newest stored day must be today (UTC), or yesterday when
 *  the cron has not fired yet. Any missing calendar day in that window is a
 *  hole and fails the gate. Seven passing days plus the deliverable done. */
export function gate(card, now = Date.now()) {
  const days = card.days || [];
  const last7 = days.slice(-7);
  const newest = days.length ? days[days.length - 1].date : null;
  const at = new Date(now);
  const today = at.toISOString().slice(0, 10);
  const yesterday = new Date(at.getTime() - DAY_MS).toISOString().slice(0, 10);
  const fresh = newest === today || (at.getUTCHours() < CRON_HOUR_UTC && newest === yesterday);
  const consecutive = fresh && last7.length === 7 && last7.every((d, i) => i === 0 || Date.parse(d.date) - Date.parse(last7[i - 1].date) === DAY_MS);
  const deliverable_done = card.deliverable?.stage === "done";
  return { days_passing: last7.filter((d) => d.pass).length, consecutive, deliverable_done, pass: consecutive && last7.every((d) => d.pass) && deliverable_done };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const space = arg("space", "madez");
  const path = arg("scorecard", null);
  const d = descriptorFromEnv();
  if (!d) {
    console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
    process.exit(1);
  }
  const res = await runCheck(fromDescriptor(d).redis, {
    space,
    mirrorSpaces: arg("mirror-spaces", "madez").split(","),
    write: !argv.includes("--dry"),
  });
  if (path) {
    const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    const card = updateScorecard(prev?.space === space ? prev : null, res);
    card.gate = gate(card);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
  }
  console.log(JSON.stringify(res, null, 2));
  // exitCode, not process.exit: stdout is the checkup JSON and must flush.
  if (!res.day.pass) process.exitCode = 1;
}
