// inbox-cockpit-model.js — pure, DOM-free triage cockpit view model for #/queue.
import { attentionKind } from './dashboard-model.js';
import { ticketStatus } from './dispatch-model.js';
import { presence, updatedLabel, relTime } from './brief-model.js';

const DAY = 86400000;
const SILENT_MS = 20 * 60 * 1000; // 20 min without write while active/idle flags silent heartbeat

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const cleanAgent = (id) =>
  String(id || '')
    .replace(/^(agent|human|person):/i, '')
    .trim();

export const isHumanRecipient = (id) => /^(human|person):/i.test(String(id || '').trim());

/** Explain the purple Needs-you badge in plain words instead of an unexplained bare integer. */
export function formatNeedsBadge(count) {
  if (count == null || !Number.isFinite(Number(count))) {
    return { text: 'Needs you: —', short: '—', aria: 'Needs you: count unavailable', zero: true };
  }
  const n = Math.max(0, Math.floor(Number(count)));
  if (n === 0) {
    return { text: '0 need you', short: '0 clear', aria: '0 items need you', zero: true };
  }
  return {
    text: n === 1 ? '1 needs you' : `${n} need you`,
    short: `${n} need you`,
    aria: `${n} ${n === 1 ? 'item needs' : 'items need'} your attention: decisions, tasks, or reviews`,
    zero: false,
  };
}

/** Sort open decisions: irreversible first (reversible !== true), then oldest first. */
export function sortDecisionsUrgency(list = []) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && typeof a === 'object')
    .slice()
    .sort((a, b) => {
      const aIrr = (a.payload || {}).reversible !== true ? 0 : 1;
      const bIrr = (b.payload || {}).reversible !== true ? 0 : 1;
      if (aIrr !== bIrr) return aIrr - bIrr;
      const aTs = num(a.ts) || Infinity;
      const bTs = num(b.ts) || Infinity;
      return aTs - bTs;
    });
}

/** Split coordination queue items into human-addressed vs agent-to-agent handoffs. */
export function splitQueueHandoffs(items = []) {
  const human = [];
  const agentToAgent = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    if (isHumanRecipient(item.to)) human.push(item);
    else agentToAgent.push(item);
  }
  return { human, agentToAgent };
}

/** Extract human tasks and reviews from home.needs_items. */
export function splitNeedsItems(needsItems = []) {
  const decisions = [];
  const tasks = [];
  const reviews = [];
  for (const item of Array.isArray(needsItems) ? needsItems : []) {
    if (!item || typeof item !== 'object') continue;
    const kind = attentionKind(item);
    if (kind === 'decision') decisions.push(item);
    else if (kind === 'task') tasks.push(item);
    else reviews.push(item);
  }
  return { decisions, tasks, reviews };
}

/** Build the Fleet right now row: blocked and active agents first, with silent heartbeat flag. */
export function extractFleetChips(agents = [], now = Date.now(), limit = 10) {
  const list = (Array.isArray(agents) ? agents : [])
    .filter((a) => a && typeof a === 'object' && a.id)
    .map((a) => {
      const p = presence(a);
      const blocked = Boolean(a.now?.blocked || a.blocked);
      const lastTs = num(a.last?.ts || a.shift?.ts || a.now?.updated_at);
      const currentJob =
        (a.now?.job && String(a.now.job).replace(/^job:/, '')) ||
        (a.now?.doing && String(a.now.doing).slice(0, 48)) ||
        'No current task';
      const silentHeartbeat =
        !blocked &&
        ((p.state === 'active' && lastTs > 0 && now - lastTs > SILENT_MS) ||
          (p.state === 'idle' && Boolean(a.now?.job)));
      const chipStatus = blocked
        ? 'blocked'
        : silentHeartbeat
          ? 'silent'
          : p.state === 'active'
            ? 'active'
            : 'quiet';
      return {
        id: String(a.id),
        name: cleanAgent(a.who?.name || a.id),
        status: chipStatus,
        statusLabel: blocked
          ? 'Blocked'
          : silentHeartbeat
            ? 'Silent heartbeat'
            : p.label,
        currentJob,
        lastWrite: a.seen ? updatedLabel(a.seen) : lastTs ? relTime(lastTs, now) : 'never wrote',
        lastTs,
        blocked,
        active: p.state === 'active',
        silentHeartbeat,
      };
    });

  const rank = { blocked: 0, active: 1, silent: 2, quiet: 3 };
  list.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] || (b.lastTs || 0) - (a.lastTs || 0) || a.name.localeCompare(b.name),
  );

  const visible = list.filter((a) => a.status !== 'quiet').slice(0, limit);
  const fallback = visible.length ? visible : list.slice(0, Math.min(6, limit));
  return {
    total: list.length,
    activeCount: list.filter((a) => a.active).length,
    blockedCount: list.filter((a) => a.blocked).length,
    chips: fallback,
  };
}

/** Build the Accepted handoffs & acknowledged reviews archive from space log + decided asks. */
export function extractArchiveEntries(logEntries = [], localAcknowledged = []) {
  const out = [];
  const seen = new Set();

  for (const ack of Array.isArray(localAcknowledged) ? localAcknowledged : []) {
    if (!ack || !ack.id || seen.has(ack.id)) continue;
    seen.add(ack.id);
    out.push(ack);
  }

  for (const e of Array.isArray(logEntries) ? logEntries : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.kind !== 'accepted' && e.kind !== 'done' && e.kind !== 'decided') continue;
    const id = String(e.trail || `${e.kind}:${e.ts}:${e.by}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: e.kind,
      by: cleanAgent(e.by || 'unknown'),
      ts: num(e.ts),
      summary: String(e.summary || ''),
      origin: String(e.origin || ''),
      where: String(e.where || e.job || ''),
    });
  }

  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

/** Filter archive entries by query, agent, and date window ('all' | '1' | '7' | '30'). */
export function filterArchive(entries = [], { query = '', agent = '', windowDays = 'all' } = {}, now = Date.now()) {
  const q = String(query || '').trim().toLowerCase();
  const ag = cleanAgent(agent).toLowerCase();
  const days = windowDays === 'all' ? 0 : Number(windowDays) || 0;
  const cutoff = days > 0 ? now - days * DAY : 0;

  return (Array.isArray(entries) ? entries : []).filter((e) => {
    if (ag && cleanAgent(e.by).toLowerCase() !== ag) return false;
    if (cutoff > 0 && (!e.ts || e.ts < cutoff)) return false;
    if (q) {
      const hay = `${e.summary} ${e.by} ${e.where} ${e.origin} ${e.kind}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Compute the 5 clickable At-a-Glance stat tiles. */
export function computeCockpitStats({
  decisions = [],
  humanHandoffs = [],
  humanTasks = [],
  reviews = [],
  agentHandoffs = [],
  agents = [],
  now = Date.now(),
} = {}) {
  const allQueue = [...humanHandoffs, ...agentHandoffs];
  const overdueCount = allQueue.filter((i) => ticketStatus(i, now) === 'overdue').length;
  const blockedCount = (Array.isArray(agents) ? agents : []).filter((a) => Boolean(a?.now?.blocked || a?.blocked)).length;
  const handoffsToAccept = humanHandoffs.length + humanTasks.length + agentHandoffs.length;

  return [
    {
      id: 'decisions',
      label: 'Decisions waiting',
      value: decisions.length,
      tone: decisions.length > 0 ? 'decision' : 'neutral',
      target: 'cockpit-decisions',
      sub: decisions.some((d) => (d.payload || {}).reversible !== true)
        ? 'irreversible first'
        : 'ready to review',
    },
    {
      id: 'handoffs',
      label: 'Handoffs to accept',
      value: handoffsToAccept,
      tone: handoffsToAccept > 0 ? 'brand' : 'neutral',
      target: humanHandoffs.length + humanTasks.length > 0 ? 'cockpit-handoffs' : 'cockpit-agent-handoffs',
      sub: `${humanHandoffs.length + humanTasks.length} for you · ${agentHandoffs.length} agent`,
    },
    {
      id: 'reviews',
      label: 'Reviews to acknowledge',
      value: reviews.length,
      tone: reviews.length > 0 ? 'warning' : 'neutral',
      target: 'cockpit-reviews',
      sub: reviews.length > 0 ? 'bulk acknowledge ready' : 'all clear',
    },
    {
      id: 'overdue',
      label: 'Overdue',
      value: overdueCount,
      tone: overdueCount > 0 ? 'danger' : 'neutral',
      action: 'filter-overdue',
      sub: overdueCount > 0 ? 'past deadline' : 'on schedule',
    },
    {
      id: 'blocked',
      label: 'Blocked agents',
      value: blockedCount,
      tone: blockedCount > 0 ? 'danger' : 'neutral',
      href: '#/agents',
      sub: `of ${(agents || []).length} total`,
    },
  ];
}

/** Deduplicated sorted agent names for the header recipient combobox. */
export function buildAgentComboboxOptions(queueItems = [], agents = [], archiveEntries = []) {
  const set = new Set();
  for (const i of Array.isArray(queueItems) ? queueItems : []) {
    if (i?.to) set.add(cleanAgent(i.to));
    if (i?.from) set.add(cleanAgent(i.from));
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a?.id) set.add(cleanAgent(a.id));
  }
  for (const e of Array.isArray(archiveEntries) ? archiveEntries : []) {
    if (e?.by) set.add(cleanAgent(e.by));
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** Check if an element is an editable form control where single-key shortcuts must not fire. */
export function isEditableTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(el.isContentEditable);
}
