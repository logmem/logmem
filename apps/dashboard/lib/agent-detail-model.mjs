// Pure view model for the Next.js Agent Details route (/space/[space]/agents/[agent]).
// Derives AgentStatus tasks and AgentTrace waterfall spans strictly from real LogMem data.
import { shortName } from './inbox-model.mjs';

const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,80}$/;

export function validAgentId(id) {
  return typeof id === 'string' && AGENT_ID_RE.test(id);
}

function mapSpanKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'started' || k === 'recap' || k === 'joined') return 'agent';
  if (k === 'progress' || k === 'research' || k === 'checkup' || k === 'pivot') return 'model';
  if (k === 'assigned' || k === 'handoff' || k === 'accepted' || k === 'approval' || k === 'fix' || k === 'decided') {
    return 'tool';
  }
  return 'io';
}

function mapSpanStatus(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'stuck' || k === 'problem' || k === 'alert') return 'error';
  return 'ok';
}

function conciseLabel(entry) {
  const kind = String(entry.kind || 'entry');
  if (entry.job && typeof entry.job === 'string') {
    const cleanJob = entry.job.replace(/^(job|channel|agent):/, '');
    return `${kind} · ${cleanJob}`;
  }
  return kind;
}

/**
 * Converts real agent shifts and log entries into an AgentTrace waterfall.
 * Picks the most recent shift when available, or groups the latest 16 chronological entries.
 */
export function buildAgentTrace(agentId, shifts = [], log = [], now = Date.now()) {
  const cleanLog = (Array.isArray(log) ? log : [])
    .filter((e) => e && typeof e === 'object' && Number(e.ts) > 0)
    .slice(0, 40)
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  const latestShift = Array.isArray(shifts) && shifts.length > 0 ? shifts[0] : null;
  const shiftId = latestShift?.shift ? String(latestShift.shift) : null;
  const shiftEntries = shiftId
    ? cleanLog.filter((e) => e.shift === shiftId)
    : cleanLog.slice(-14);
  const chosen = shiftEntries.length > 0 ? shiftEntries.slice(-16) : cleanLog.slice(-14);

  if (chosen.length === 0) {
    return { runId: shiftId || `agent:${agentId}`, model: latestShift?.surface || null, duration: 0, spans: [] };
  }

  const originTs = Number(latestShift?.started_at || chosen[0].ts);
  const lastTs = Math.max(
    Number(latestShift?.ended_at || chosen[chosen.length - 1].ts),
    Number(chosen[chosen.length - 1].ts),
    originTs + 1000,
  );
  const totalMs = Math.max(1000, Math.min(lastTs - originTs, 24 * 3_600_000));
  const minBarMs = Math.max(150, Math.round(totalMs * 0.04));

  const rootId = shiftId || `run-${agentId}`;
  const spans = [
    {
      id: rootId,
      label: `shift.${agentId}`,
      kind: 'agent',
      status: 'ok',
      start: 0,
      end: totalMs,
      detail: `${chosen.length} ${chosen.length === 1 ? 'entry' : 'entries'}`,
      summary: latestShift?.surface ? `Shift via ${latestShift.surface}` : 'Recorded activity window',
      trail: shiftId || null,
      ts: originTs,
    },
  ];

  for (let i = 0; i < chosen.length; i += 1) {
    const e = chosen[i];
    const next = chosen[i + 1];
    const start = Math.max(0, Math.min(totalMs - minBarMs, Number(e.ts) - originTs));
    const rawEnd = next ? Math.max(start + minBarMs, Number(next.ts) - originTs) : totalMs;
    const end = Math.min(totalMs, Math.max(start + minBarMs, rawEnd));
    const summary = String(e.summary || '').trim();
    spans.push({
      id: String(e.trail || `${rootId}-${i}`),
      parentId: rootId,
      label: conciseLabel(e),
      kind: mapSpanKind(e.kind),
      status: mapSpanStatus(e.kind),
      start,
      end,
      detail: summary.length > 42 ? `${summary.slice(0, 39)}…` : summary || String(e.kind || ''),
      summary,
      trail: e.trail ? String(e.trail) : null,
      ts: Number(e.ts),
      entryKind: String(e.kind || 'memo'),
    });
  }

  return {
    runId: shiftId || `agent:${agentId}`,
    model: latestShift?.surface ? String(latestShift.surface) : null,
    duration: totalMs,
    spans,
    asOf: now,
  };
}

export function buildAgentDetail(rawView, rawJobs = [], now = Date.now()) {
  if (!rawView || typeof rawView !== 'object' || !rawView.id) return null;
  const id = shortName(String(rawView.id));
  const who = rawView.who && typeof rawView.who === 'object' ? rawView.who : {};
  const nowSlot = rawView.now && typeof rawView.now === 'object' ? rawView.now : {};
  const seen = rawView.seen && typeof rawView.seen === 'object' ? rawView.seen : {};
  const recap = rawView.recap && typeof rawView.recap === 'object' ? rawView.recap : null;
  const follows = Array.isArray(rawView.follows) ? rawView.follows.map(String) : [];
  const shifts = Array.isArray(rawView.shifts) ? rawView.shifts : [];
  const log = Array.isArray(rawView.log) ? rawView.log : [];
  const handoffs = Array.isArray(rawView.handoffs) ? rawView.handoffs : [];

  const ownedJobs = (Array.isArray(rawJobs) ? rawJobs : [])
    .filter((j) => j && typeof j === 'object' && shortName(String(j.owner || '')) === id)
    .map((j) => ({
      id: String(j.id || ''),
      title: String(j.title || j.id || 'Untitled'),
      stage: String(j.stage || 'open'),
      plan: j.plan ? String(j.plan) : null,
    }))
    .filter((j) => j.id);

  // Build real AgentStatus task tray from open handoffs + owned jobs (zero synthetic items).
  const statusTasks = [
    ...handoffs.slice(0, 4).map((h, i) => ({
      id: `handoff-${h.trail || i}`,
      label: String(h.summary || 'Pending handoff'),
      status: 'pending',
      meta: h.by ? `from ${shortName(String(h.by))}` : 'handoff',
    })),
    ...ownedJobs
      .filter((j) => j.stage === 'active' || j.stage === 'blocked')
      .slice(0, 4)
      .map((j) => ({
        id: `job-${j.id}`,
        label: j.title,
        status: j.stage === 'active' ? 'running' : 'pending',
        meta: j.stage,
      })),
    ...ownedJobs
      .filter((j) => j.stage === 'done')
      .slice(0, 3)
      .map((j) => ({
        id: `done-${j.id}`,
        label: j.title,
        status: 'complete',
        meta: 'done',
      })),
  ];

  const trace = buildAgentTrace(id, shifts, log, now);

  return {
    id,
    name: typeof who.name === 'string' && who.name.trim() ? who.name.trim() : id,
    role: typeof who.role === 'string' && who.role.trim() ? who.role.trim() : null,
    skills: Array.isArray(who.skills) ? who.skills.map(String).slice(0, 10) : [],
    state: typeof seen.state === 'string' ? seen.state : 'unknown',
    statusLabel: typeof seen.label === 'string' ? seen.label : 'unknown',
    doing: typeof nowSlot.doing === 'string' && nowSlot.doing.trim() ? nowSlot.doing.trim() : null,
    next: typeof nowSlot.next === 'string' && nowSlot.next.trim() ? nowSlot.next.trim() : null,
    blocked: nowSlot.blocked === true,
    job: typeof nowSlot.job === 'string' && nowSlot.job.trim() ? nowSlot.job.trim() : null,
    plan: typeof nowSlot.plan === 'string' && nowSlot.plan.trim() ? nowSlot.plan.trim() : null,
    surface: shifts[0]?.surface ? String(shifts[0].surface) : null,
    recap: recap
      ? {
          summary: String(recap.summary || ''),
          mode: recap.mode ? String(recap.mode) : null,
          endedAt: Number(recap.ended_at || recap.updated_at || 0) || null,
          next: Array.isArray(recap.next) ? recap.next.map(String) : [],
        }
      : null,
    follows,
    ownedJobs,
    handoffs: handoffs.map((h, i) => ({
      id: String(h.trail || `h-${i}`),
      by: h.by ? shortName(String(h.by)) : 'unknown',
      summary: String(h.summary || ''),
      ts: Number(h.ts || 0),
      where: h.job ? String(h.job) : null,
    })),
    shifts: shifts.map((s, i) => ({
      id: String(s.shift || `shift-${i}`),
      surface: s.surface ? String(s.surface) : 'unknown',
      startedAt: Number(s.started_at || s.ts || 0),
      endedAt: Number(s.ended_at || 0) || null,
      entryCount: Number(s.entry_count || 0),
    })),
    log: log.slice(0, 50).map((e, i) => ({
      id: String(e.trail || `log-${i}`),
      kind: String(e.kind || 'memo'),
      summary: String(e.summary || ''),
      ts: Number(e.ts || 0),
      where: e.job ? String(e.job) : null,
      via: e.via ? String(e.via) : null,
    })),
    statusTasks,
    trace,
  };
}
