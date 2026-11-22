// Pure view model for the Next.js Agents route (/space/[space]/agents).
import { shortName } from './inbox-model.mjs';

export function normalizeAgents(rawAgents = []) {
  if (!Array.isArray(rawAgents)) return [];
  return rawAgents
    .filter((a) => a && typeof a === 'object' && a.id)
    .map((a) => {
      const state = typeof a.seen?.state === 'string' ? a.seen.state : 'unknown';
      const label = typeof a.seen?.label === 'string' && a.seen.label ? a.seen.label : state;
      const doing =
        (typeof a.now?.doing === 'string' && a.now.doing.trim()) ||
        (typeof a.now?.current_task === 'string' && a.now.current_task.trim()) ||
        (a.now?.job ? `On ${a.now.job}` : null);
      const lastTs = Number(a.last?.ts || a.shift?.ts || 0);
      return {
        id: String(a.id),
        name: shortName(String(a.who?.name || a.id)),
        role: typeof a.who?.role === 'string' ? a.who.role : null,
        state,
        statusLabel: label,
        doing,
        blocked: Boolean(a.now?.blocked),
        job: a.now?.job ? String(a.now.job) : null,
        surface: a.shift?.surface ? String(a.shift.surface) : a.last?.via ? String(a.last.via) : null,
        recapSummary: a.recap?.summary ? String(a.recap.summary) : null,
        recapMode: a.recap?.mode ? String(a.recap.mode) : null,
        lastTs: Number.isFinite(lastTs) && lastTs > 0 ? lastTs : null,
      };
    })
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

export function agentCounts(agents = []) {
  let active = 0;
  let idle = 0;
  let quiet = 0;
  for (const a of agents) {
    if (a.state === 'active') active += 1;
    else if (a.state === 'idle' || a.state === 'recent') idle += 1;
    else quiet += 1;
  }
  return { total: agents.length, active, idle, quiet };
}
