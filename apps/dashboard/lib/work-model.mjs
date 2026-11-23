// Pure view model for the Next.js Work route (/space/[space]/work).
import { shortName } from './inbox-model.mjs';

const STAGE_ORDER = ['blocked', 'active', 'open', 'done'];

export function normalizeJobs(rawJobs = []) {
  if (!Array.isArray(rawJobs)) return [];
  return rawJobs
    .filter((j) => j && typeof j === 'object' && j.milestone !== true)
    .map((j) => {
      const stage = typeof j.stage === 'string' && j.stage.trim() ? j.stage.trim().toLowerCase() : 'open';
      const ts = Number(j.last?.ts || j.stage_at || 0);
      return {
        id: String(j.id || ''),
        title: String(j.title || j.id || 'Untitled job'),
        stage,
        owner: j.owner ? shortName(String(j.owner)) : null,
        plan: j.plan ? String(j.plan) : null,
        track: j.track ? String(j.track) : null,
        due: j.due ? String(j.due) : null,
        blockedNote:
          j.blocked_on && typeof j.blocked_on === 'object' && j.blocked_on.note
            ? String(j.blocked_on.note)
            : null,
        lastSummary: j.last?.summary ? String(j.last.summary) : null,
        updatedAt: Number.isFinite(ts) && ts > 0 ? ts : null,
      };
    })
    .filter((j) => j.id)
    .sort((a, b) => {
      const ia = STAGE_ORDER.indexOf(a.stage);
      const ib = STAGE_ORDER.indexOf(b.stage);
      const ra = ia === -1 ? 99 : ia;
      const rb = ib === -1 ? 99 : ib;
      if (ra !== rb) return ra - rb;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

export function stageCounts(jobs = []) {
  const c = { all: jobs.length, active: 0, blocked: 0, open: 0, done: 0 };
  for (const j of jobs) {
    if (j.stage === 'active') c.active += 1;
    else if (j.stage === 'blocked') c.blocked += 1;
    else if (j.stage === 'done') c.done += 1;
    else c.open += 1;
  }
  return c;
}

export function filterJobsByStage(jobs = [], stage = 'all') {
  if (stage === 'all') return jobs;
  if (stage === 'open') {
    return jobs.filter((j) => !['active', 'blocked', 'done'].includes(j.stage));
  }
  return jobs.filter((j) => j.stage === stage);
}
