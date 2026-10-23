// Read one actor's logical writes across every work log in this space.
import { checkAgentId } from "./keys.mjs";
import { stableJson } from "./store.mjs";

export async function readShiftEntries(store, { agent, shift, sinceMs, untilMs }) {
  const actor = `agent:${checkAgentId(agent)}`;
  const sources = new Map([[actor, ["agent", agent]]]);
  const read_errors = [];
  const floor = store.historyFloorMs?.();
  if (floor != null && sinceMs < floor) {
    read_errors.push({ ref: "logs:*", reason: "history_limited" });
  }
  for (const ns of ["agent", "job", "channel"]) {
    try {
      for (const id of await store.list(ns)) sources.set(`${ns}:${id}`, [ns, id]);
    } catch {
      read_errors.push({ ref: `${ns}:*`, reason: "roster_read_failed" });
    }
  }
  // An append can land before its roster update fails. Discover those logs
  // too, so a missing index member cannot turn written work into silence.
  try {
    let cursor = "0";
    const prefix = `lm:${store.space}:`;
    do {
      const [next, keys] = await store.redis("SCAN", cursor, "MATCH", `${prefix}*:log`, "COUNT", "1000");
      cursor = String(next);
      for (const key of keys) {
        if (!key.startsWith(prefix) || !key.endsWith(":log")) continue;
        const ref = key.slice(prefix.length, -4);
        const split = ref.indexOf(":");
        const ns = ref.slice(0, split), id = ref.slice(split + 1);
        if (["agent", "job", "channel"].includes(ns)) sources.set(ref, [ns, id]);
      }
    } while (cursor !== "0");
  } catch {
    read_errors.push({ ref: "logs:*", reason: "log_discovery_failed" });
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
