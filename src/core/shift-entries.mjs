// Read one actor's logical writes across every work log in this space.
import { checkAgentId } from "./keys.mjs";
import { stableJson } from "./store.mjs";

export async function readShiftEntries(store, { agent, shift, sinceMs, untilMs }) {
  const actor = `agent:${checkAgentId(agent)}`;
  const sources = new Map([[actor, ["agent", agent]]]);
  const read_errors = [];
  for (const ns of ["agent", "job", "channel"]) {
    try {
      for (const id of await store.list(ns)) sources.set(`${ns}:${id}`, [ns, id]);
    } catch {
      read_errors.push({ ref: `${ns}:*`, reason: "roster_read_failed" });
    }
  }
  const unique = new Map();
  const refs = [...sources.entries()];
  // Bound concurrent bridge requests. Never cap the number of logs or entries.
  for (let i = 0; i < refs.length; i += 20) {
    const rows = await Promise.all(refs.slice(i, i + 20).map(async ([ref, [ns, id]]) => {
      try {
        const entries = await store.readLog(ns, id, { sinceMs, untilMs });
        if (entries.warnings?.length) read_errors.push({ ref, reason: "unreadable_legacy_log" });
        return entries;
      } catch {
        read_errors.push({ ref, reason: "log_read_failed" });
        return [];
      }
    }));
    for (const entries of rows) for (const entry of entries) {
      if (entry.by !== actor || entry.shift !== shift) continue;
      unique.set(stableJson(entry), entry);
    }
  }
  const entries = [...unique.values()].sort((a, b) => a.ts - b.ts);
  read_errors.sort((a, b) => a.ref.localeCompare(b.ref));
  return { entries, coverage: read_errors.length ? "partial" : "complete", read_errors };
}
