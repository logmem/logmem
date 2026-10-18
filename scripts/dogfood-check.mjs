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
// Writes one "checkup" entry on job:logmem-dogfood per UTC day (a rerun the same
// day replaces it) and upserts the day into the scorecard at
// lm:{space}:dogfood:scorecard (JSON in Redis). Optionally also into a file.
//
// Primary path: Vercel Cron -> api/cron/dogfood-check.mjs (13:00 UTC daily).
// Manual run of one day, against the backend in env:
//
//   LOGMEM_REST_URL=... LOGMEM_REST_TOKEN=... node scripts/dogfood-check.mjs --space madez
//     [--mirror-spaces madez] [--scorecard path/to/scorecard.json] [--dry]
//
// --dry computes the day and prints it; it writes nothing (no checkup, no scorecard).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createStore, tryParse, normTs } from "../src/core/store.mjs";
import { createMirror } from "../src/core/mirror.mjs";
import { acmiKey } from "../src/core/keys.mjs";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { validateKeySegments } from "../src/lib/helpers.mjs";
import { handoffSettlement, isDeclined } from "../src/core/tools.mjs";

export const DAY_MS = 24 * 3600 * 1000;
export const CHECK_JOB = "logmem-dogfood";
export const DELIVERABLE_JOB = "logmem-v0-ship";
export const CHECK_BY = "agent:logmem-check";
const BY = CHECK_BY;

/** Where the scorecard lives (JSON string). Written only by the check. */
export function scorecardKey(space) {
  validateKeySegments(space);
  return `lm:${space}:dogfood:scorecard`;
}
const lockKey = (space) => `lm:${space}:dogfood:lock`;

/**
 * The pause switch (Mikey, 2026-10-17). JSON {since: "YYYY-MM-DD", reason, by}.
 * While it is set the check still runs, but days from `since` on are marked
 * paused: they do not count toward the 7-day bar and do not break the streak,
 * and the check writes no stuck alerts. Delete the key to resume.
 */
export function pauseKey(space) {
  validateKeySegments(space);
  return `lm:${space}:dogfood:pause`;
}

/** Mark every day since the pause began as paused. Days stay paused after the key is removed. */
export function applyPause(card, pause) {
  if (!pause) return card;
  for (const d of card.days || []) if (d.date >= pause.since) d.paused = true;
  card.pause = pause;
  return card;
}

/** Mark the stored rows before trimming, so a backdated pause never trims counted days first. */
function markPaused(card, pause) {
  if (card && pause) for (const d of card.days || []) if (d.date >= pause.since) d.paused = true;
  return card;
}
function markPausedDay(res, pause) {
  return pause && res.day.date >= pause.since ? { ...res, day: { ...res.day, paused: true } } : res;
}

/** Upsert a day into the optional scorecard file, with the same pause marks as Redis. */
export function updateScorecardFile(path, space, res, pause) {
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const card = applyPause(updateScorecard(markPaused(prev?.space === space ? prev : null, pause), markPausedDay(res, pause)), pause);
  card.gate = gate(card);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
  return card;
}

/** A real YYYY-MM-DD date: 2026-99-99 and 2026-02-30 are not. */
export function isCalendarDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(v + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** The pause record, or null when there is none or it is not usable. */
export async function readPause(redis, space) {
  const p = tryParse(await redis("GET", pauseKey(space)));
  return p && typeof p === "object" && isCalendarDate(p.since) ? { since: p.since, reason: String(p.reason || ""), by: String(p.by || "") } : null;
}

/** ACMI twins of one mirrored checkup (same ts, same trail, written by the mirror). */
async function removeAcmiTwins(redis, space, entry) {
  const key = acmiKey(space, "job", CHECK_JOB, "log");
  let n = 0;
  for (const m of (await redis("ZRANGEBYSCORE", key, entry.ts, entry.ts)) || []) {
    const t = tryParse(m);
    if (t && t.source === BY && t.correlationId === entry.trail && t.mirrored_from === "lm") n += Number(await redis("ZREM", key, m)) || 0;
  }
  return n;
}

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

/** An ACMI row that answers a handoff: an ack, an accept, or a decline (feedback marked declined). */
function acmiAnswers(r) {
  if (["handoff-ack", "accepted"].includes(r.kind)) return true;
  return ["feedback", "review-note"].includes(r.kind) && isDeclined(r.payload);
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
  stuck = true,
} = {}) {
  const store = createStore(redis, { space, compat: false });
  const from = now - windowMs;
  const mirrored = mirrorSpaces.includes(space);
  const logKeys = (await scan(redis, `lm:${space}:*:log`)).map((k) => ({ key: k, ...parseLogKey(k, space) })).filter((x) => x.ns);

  const day = { date: new Date(now).toISOString().slice(0, 10), window: [from, now], ran: true, space, mirror_checked: mirrored, entries: 0, agents: [], mirror_mismatches: 0, mismatch_examples: [], degraded_sessions: 0, handoffs: 0, accepted: 0, unanswered_24h: 0, stuck_written: 0 };
  const agents = new Set();
  const handoffs = new Map(); // trail -> { ts, to, where, logs: [{ ns, id }] } (a handoff is written to more than one log)
  const accepts = new Set(); // trails accepted (lm side)
  const stuckAlready = new Set();

  for (const { ns, id } of logKeys) {
    if (ns === "job" && id === CHECK_JOB) continue; // the audit log doesn't audit itself
    const recent = await store.readLog(ns, id, { sinceMs: now - lookbackMs, untilMs: now });
    for (const e of recent) {
      if (e.origin && handoffSettlement(e.kind, e.payload)) accepts.add(e.origin); // accepted, or declined: both answer it
      if (e.kind === "stuck" && e.payload?.unanswered_handoff) stuckAlready.add(e.payload.unanswered_handoff);
      if (e.kind === "handoff" && e.trail) {
        const h = handoffs.get(e.trail);
        if (!h) handoffs.set(e.trail, { ts: e.ts, to: e.to, where: e.job, logs: [{ ns, id }] });
        else if (!h.logs.some((l) => l.ns === ns && l.id === id)) h.logs.push({ ns, id });
      }
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
    // Every log the handoff was written to, plus the recipient's own timeline.
    const keys = new Set([acmiKey(space, "agent", String(h.to || "").replace(/^agent:/, ""), "log"), ...h.logs.map((l) => acmiKey(space, l.ns, l.id, "log"))]);
    for (const k of keys) {
      const rows = await acmiRows(redis, k, h.ts, "+inf");
      if (rows.some((r) => r.parentCorrelationId === trail && acmiAnswers(r))) return true;
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

  let replaced = 0;
  if (write) {
    const writer = createStore(redis, { space, mirror: mirrored ? createMirror(redis, space) : null });
    for (const { trail, h } of stuck ? stuckToWrite : []) {
      await writer.append(h.logs[0].ns, h.logs[0].id, { // the first log the handoff was seen in, as before
        ts: now, kind: "stuck", by: BY, via: "dogfood-check", byline: "logmem-check (via dogfood-check)",
        trail: `stuckHandoff-${now}`, origin: trail, summary: `Handoff to ${h.to} unanswered for more than 24h`,
        payload: { unanswered_handoff: trail },
      });
      day.stuck_written++;
    }
    // One checkup per UTC day: earlier checkups for this date (same trail,
    // written by the check) are replaced. Append first, then remove, so a
    // failed write never leaves the day without a checkup.
    const trail = `dogfoodCheck-${day.date}`;
    const dayStart = Date.parse(`${day.date}T00:00:00Z`);
    const priors = (await writer.readLog("job", CHECK_JOB, { sinceMs: dayStart, untilMs: dayStart + DAY_MS - 1 }))
      .filter((e) => e.kind === "checkup" && e.by === BY && e.trail === trail && e.ts !== now);
    await writer.append("job", CHECK_JOB, {
      ts: now, kind: "checkup", by: BY, via: "dogfood-check", byline: "logmem-check (via dogfood-check)",
      trail, summary: `${day.date} ${day.pass ? "PASS" : "FAIL"}: ${day.agents.length} agents, ${day.entries} entries, ${day.handoffs} handoffs (${day.accepted} accepted), ${day.mirror_mismatches} mirror mismatches, ${day.unanswered_24h} unanswered >24h, ${day.degraded_sessions} degraded`,
      payload: day,
    });
    for (const p of priors) {
      replaced += await writer.removeEntry("job", CHECK_JOB, p);
      if (mirrored) await removeAcmiTwins(redis, space, p);
    }
  }
  return { day, deliverable, replaced };
}

/**
 * One scheduled run for one space: the check (writes the checkup) plus the
 * scorecard upsert in Redis. A short lock (SET NX EX) keeps two overlapping
 * runs (Vercel may deliver a cron event twice) from racing on the same day.
 * Returns { space, skipped: "locked" } when another run holds the lock.
 */
export async function runDaily(redis, { space, mirrorSpaces = ["madez"], now = Date.now(), lockTtlS = 600 } = {}) {
  const key = scorecardKey(space);
  const lock = lockKey(space);
  const token = randomUUID();
  if ((await redis("SET", lock, token, "NX", "EX", String(lockTtlS))) == null) return { space, skipped: "locked" };
  try {
    const pause = await readPause(redis, space);
    const res = await runCheck(redis, { space, mirrorSpaces, now, write: true, stuck: !pause });
    const prev = tryParse(await redis("GET", key));
    const usable = prev && typeof prev === "object" && prev.space === space && Array.isArray(prev.days) ? prev : null;
    const card = applyPause(updateScorecard(markPaused(usable, pause), markPausedDay(res, pause), new Date(now).toISOString()), pause);
    card.gate = gate(card);
    card.by = BY;
    await redis("SET", key, JSON.stringify(card));
    return { space, date: res.day.date, pass: res.day.pass, replaced: res.replaced, res, card };
  } finally {
    try {
      if ((await redis("GET", lock)) === token) await redis("DEL", lock);
    } catch {
      // the lock expires on its own (EX)
    }
  }
}

/** Upsert a day into scorecard JSON (keeps the newest 30 counted days, plus paused days). */
export const MAX_ROWS = 400;
export function updateScorecard(card, { day, deliverable }, generatedAt = new Date().toISOString()) {
  const days = (card?.days || []).filter((d) => d.date !== day.date);
  const { mismatch_examples, window, ...slim } = day;
  days.push({ ...slim, mismatch_examples });
  days.sort((a, b) => a.date.localeCompare(b.date));
  // Keep the newest 30 counted days, and the paused days between and after them,
  // so a long pause never pushes counted days out. Hard cap: MAX_ROWS rows.
  const counted = days.filter((d) => !d.paused).slice(-30);
  const floor = counted[0]?.date ?? "";
  const keep = new Set(counted);
  const kept = days.filter((d) => keep.has(d) || (d.paused && d.date >= floor)).slice(-MAX_ROWS);
  return { generated_at: generatedAt, space: day.space, days: kept, deliverable };
}

/** The 7-day bar: 7 consecutive passing days ending at the newest, plus the deliverable done. */
export function gate(card) {
  const all = card.days || [];
  const paused = new Set(all.filter((d) => d.paused).map((d) => d.date));
  const last7 = all.filter((d) => !d.paused).slice(-7);
  // Two counted days are back to back when every date between them is a paused day.
  const adjacent = (a, b) => {
    for (let t = Date.parse(a.date) + DAY_MS; t < Date.parse(b.date); t += DAY_MS) {
      if (!paused.has(new Date(t).toISOString().slice(0, 10))) return false;
    }
    return Date.parse(b.date) > Date.parse(a.date);
  };
  const consecutive = last7.length === 7 && last7.every((d, i) => i === 0 || adjacent(last7[i - 1], d));
  return { days_passing: last7.filter((d) => d.pass).length, consecutive, ...(paused.size ? { paused_days: paused.size } : {}), deliverable_done: card.deliverable?.stage === "done", pass: consecutive && last7.every((d) => d.pass) && card.deliverable?.stage === "done" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const space = arg("space", "madez");
  const path = arg("scorecard", null);
  const mirrorSpaces = arg("mirror-spaces", "madez").split(",").map((x) => x.trim()).filter(Boolean);
  const dry = argv.includes("--dry");
  const d = descriptorFromEnv();
  if (!d) {
    console.error("set LOGMEM_REDIS_URI or LOGMEM_REST_URL + LOGMEM_REST_TOKEN");
    process.exit(1);
  }
  const redis = fromDescriptor(d).redis;
  let res;
  if (dry) {
    res = await runCheck(redis, { space, mirrorSpaces, write: false });
  } else {
    const out = await runDaily(redis, { space, mirrorSpaces });
    if (out.skipped) {
      console.error(`${space}: another check run holds the lock; try again in a few minutes`);
      process.exit(2);
    }
    res = out.res;
    console.error(`${space} ${out.date} ${out.pass ? "PASS" : "FAIL"}; scorecard written to ${scorecardKey(space)}${out.replaced ? ` (replaced ${out.replaced} earlier checkup today)` : ""}`);
  }
  if (path) updateScorecardFile(path, space, res, await readPause(redis, space));
  console.log(JSON.stringify(res, null, 2));
}
