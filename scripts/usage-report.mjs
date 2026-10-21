#!/usr/bin/env node
// usage-report.mjs — read-only usage for one space over the last N days (plans-metering, weekly).
// Counts log entries (each is one "add" on the meter), the agents and people who wrote them,
// and a month estimate (x30/N). Recalls are not logged, so they are not counted here.
//   node scripts/usage-report.mjs --space=madez --days=7
import { pathToFileURL } from "node:url";
import { fromDescriptor, descriptorFromEnv } from "../src/lib/backend.mjs";
import { normTs } from "../src/core/store.mjs";

const NAMESPACES = ["agent", "channel", "job"];
const MAX_DATE_MS = 8.64e15;

/** Usage for `space` from `now - days` to `now`. `redis` is a runner: (cmd, ...args) => result. */
export async function usageReport(redis, { space, days = 7, now = Date.now() }) {
  const since = now - days * 86400000;
  const out = { space, days, since, until: now, entries: 0, logs: {}, by_day: {}, writers: {}, unreadable: 0 };
  for (const ns of NAMESPACES) {
    const ids = (await redis("SMEMBERS", `lm:${space}:${ns}:list`)) || [];
    let entries = 0, active = 0;
    for (const id of ids) {
      const rows = (await redis("ZRANGEBYSCORE", `lm:${space}:${ns}:${id}:log`, String(since), String(now))) || [];
      if (rows.length) active++;
      entries += rows.length;
      for (const raw of rows) {
        // One bad row never aborts the report: it is counted as an entry (the score was in the
        // window) and as unreadable. Timestamps go through the store's own normalizer (ISO or ms).
        // A row must be a JSON object; null, arrays and bare values are unreadable.
        // A timestamp must be a real date (Date's range is +-8.64e15 ms).
        let e;
        try { e = JSON.parse(raw); } catch { out.unreadable++; continue; }
        if (e === null || typeof e !== "object" || Array.isArray(e)) { out.unreadable++; continue; }
        const ts = normTs(e.ts);
        if (Number.isFinite(ts) && ts > 0 && ts <= MAX_DATE_MS) {
          const day = new Date(ts).toISOString().slice(0, 10);
          out.by_day[day] = (out.by_day[day] || 0) + 1;
        } else out.unreadable++;
        const w = String(e.by || "unknown");
        out.writers[w] = (out.writers[w] || 0) + 1;
      }
    }
    out.logs[ns] = { total: ids.length, active, entries };
    out.entries += entries;
  }
  const writers = Object.keys(out.writers);
  out.agents = writers.filter((w) => w.startsWith("agent:")).length;
  out.people = writers.filter((w) => w.startsWith("human:")).length;
  out.month_estimate = Math.round((out.entries * 30) / days);
  out.one_tenth = { entries: Math.round(out.month_estimate / 10), agents: Math.max(1, Math.round(out.agents / 10)) };
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
  const space = arg("space", process.env.LOGMEM_SPACE || "madez");
  const days = Number(arg("days", "7"));
  try {
    const redis = fromDescriptor(descriptorFromEnv(process.env)).redis;
    const r = await usageReport(redis, { space, days });
    console.log(JSON.stringify(r, null, 1));
  } catch {
    console.log(JSON.stringify({ ok: false, error: "Usage report failed. Check the backend settings." }));
    process.exitCode = 1;
  }
}
