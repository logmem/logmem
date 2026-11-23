// Pure view model for the Next.js Activity route (/space/[space]/activity).
import { shortName } from './inbox-model.mjs';

const GROUPS = {
  assigned: 'work',
  progress: 'work',
  done: 'work',
  shared: 'work',
  research: 'work',
  checkup: 'work',
  feedback: 'work',
  handoff: 'handoff',
  accepted: 'handoff',
  stuck: 'signal',
  alert: 'signal',
  memo: 'signal',
  huddle: 'signal',
  approval: 'decision',
  decided: 'decision',
  pivot: 'decision',
  problem: 'error',
  fix: 'error',
  started: 'system',
  ping: 'system',
  recap: 'system',
  joined: 'system',
  setup: 'system',
};

export function entryKindGroup(kind) {
  if (!kind) return 'neutral';
  return GROUPS[String(kind).toLowerCase()] || 'neutral';
}

export function normalizeEntries(rawEntries = []) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries
    .filter((e) => e && typeof e === 'object')
    .map((e, idx) => {
      const ts = Number(e.ts || 0);
      const kind = e.kind ? String(e.kind) : 'memo';
      return {
        key: `${ts}-${e.trail || idx}-${idx}`,
        ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
        kind,
        group: entryKindGroup(kind),
        actor: e.by ? shortName(String(e.by)) : 'unknown',
        summary: String(e.summary || '(no summary)'),
        where: e.where ? String(e.where) : null,
        trail: e.trail ? String(e.trail) : null,
        origin: e.origin ? String(e.origin) : null,
        via: e.via ? String(e.via) : null,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}

export function groupCounts(entries = []) {
  const counts = { all: entries.length, work: 0, handoff: 0, signal: 0, decision: 0, error: 0, system: 0 };
  for (const e of entries) {
    if (e.group in counts) counts[e.group] += 1;
  }
  return counts;
}

export function filterEntriesByGroup(entries = [], group = 'all') {
  if (group === 'all') return entries;
  return entries.filter((e) => e.group === group);
}
