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
