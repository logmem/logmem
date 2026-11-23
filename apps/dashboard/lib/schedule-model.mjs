// Pure view model for the Next.js Schedule route (/space/[space]/schedule).
// Derives real recent/active shifts from agents and dated milestones/jobs from jobs.
// Never invents cron schedules or synthetic dates.
import { shortName } from './inbox-model.mjs';

export function buildSchedule(rawAgents = [], rawJobs = []) {
  const shifts = (Array.isArray(rawAgents) ? rawAgents : [])
    .filter((a) => a && typeof a === 'object' && a.shift && Number(a.shift.ts) > 0)
    .map((a) => ({
      id: String(a.shift.shift || `${a.id}-${a.shift.ts}`),
      agent: shortName(String(a.id)),
      surface: a.shift.surface ? String(a.shift.surface) : 'unknown',
      startedAt: Number(a.shift.ts),
      lastAt: Number(a.last?.ts) > 0 ? Number(a.last.ts) : Number(a.shift.ts),
      state: typeof a.seen?.state === 'string' ? a.seen.state : 'unknown',
      statusLabel: typeof a.seen?.label === 'string' ? a.seen.label : 'unknown',
      doing: typeof a.now?.doing === 'string' && a.now.doing.trim() ? a.now.doing.trim() : null,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);

  const upcoming = (Array.isArray(rawJobs) ? rawJobs : [])
    .filter((j) => j && typeof j === 'object' && j.stage !== 'done' && (j.due || j.date))
    .map((j) => ({
      id: String(j.id || ''),
      title: String(j.title || j.id || 'Untitled'),
      due: String(j.due || j.date),
      isMilestone: j.milestone === true,
      owner: j.owner ? shortName(String(j.owner)) : null,
      stage: typeof j.stage === 'string' ? j.stage : 'open',
      plan: j.plan ? String(j.plan) : null,
    }))
    .filter((j) => j.id)
    .sort((a, b) => a.due.localeCompare(b.due));

  return { shifts, upcoming };
}

function pad2(n) {
  return String(Math.max(0, Math.floor(n))).padStart(2, '0');
}

/**
 * Projects real recorded agent shifts onto a read-only 24h timeline grid.
 * Uses UTC hours so server and client render deterministically with zero hydration drift.
 */
export function buildShiftTimeline(shifts = [], now = Date.now()) {
  const valid = (Array.isArray(shifts) ? shifts : []).filter(
    (s) => s && typeof s === 'object' && Number(s.startedAt) > 0 && s.agent,
  );
  if (valid.length === 0) {
    return { rows: [], slots: [], config: { startHour: 0, endHour: 24, columnWidth: 152 } };
  }

  const rowMap = new Map();
  const slots = [];
  let minHour = 23;
  let maxHour = 1;

  for (const s of valid) {
    if (!rowMap.has(s.agent)) {
      rowMap.set(s.agent, {
        id: s.agent,
        label: s.agent,
        surface: s.surface || 'unknown',
        state: s.state || 'unknown',
        statusLabel: s.statusLabel || 'unknown',
      });
    }
    const startDate = new Date(Number(s.startedAt));
    const startHour = startDate.getUTCHours();
    const startMin = startDate.getUTCMinutes();
    const endTs = Math.max(Number(s.lastAt || s.startedAt), Number(s.startedAt));
    const rawMins = Math.round((Math.min(endTs, now) - Number(s.startedAt)) / 60_000);
    // Keep narrow shifts readable on the timeline while capping within a day window.
    const duration = Math.max(30, Math.min(360, rawMins > 0 ? rawMins : 45));
    const endHour = Math.min(24, Math.ceil((startHour * 60 + startMin + duration) / 60));

    if (startHour < minHour) minHour = startHour;
    if (endHour > maxHour) maxHour = endHour;

    slots.push({
      id: s.id,
      rowId: s.agent,
      agent: s.agent,
      surface: s.surface || 'unknown',
      state: s.state || 'unknown',
      statusLabel: s.statusLabel || 'unknown',
      doing: s.doing || null,
      startedAt: Number(s.startedAt),
      startTime: `${pad2(startHour)}:${pad2(startMin)}`,
      duration,
    });
  }

  const spanStart = Math.max(0, minHour - 1);
  const spanEnd = Math.min(24, Math.max(spanStart + 6, maxHour + 1));

  return {
    rows: Array.from(rowMap.values()),
    slots,
    config: { startHour: spanStart, endHour: spanEnd, columnWidth: 156 },
  };
}
