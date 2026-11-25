// apps/dashboard/lib/server/inbox.ts
// Inbox cockpit data: audit pending handoffs + home fleet/tasks/reviews + open decisions + archive log,
// read in process through the viewer's read-only jailed runner.
import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';

export interface InboxItem {
  id: string;
  type: string;
  request_trail?: string;
  from: string;
  to: string;
  where?: string;
  summary: string;
  created_at: number;
  deadline: number;
  response?: string;
  source?: string;
}

export interface InboxDecision {
  trail: string;
  summary: string;
  by: string;
  ts: number;
  where?: string;
  ask_digest?: string;
  deferred?: { at: number; by: string; note?: string } | null;
  payload?: { action?: string; reversible?: boolean };
}

export interface InboxTask {
  trail: string;
  summary: string;
  by: string;
  job?: string;
  plan?: string;
  due?: string;
  stepsDone: number;
  stepsTotal: number;
}

export interface InboxReview {
  job: string;
  summary: string;
  evidence?: string;
  owner?: string;
  plan?: string;
  created_at?: number;
}

export interface InboxAgent {
  id: string;
  who?: { name?: string };
  now?: { job?: string; doing?: string; blocked?: unknown; updated_at?: number };
  seen?: { state?: string; since?: string };
  last?: { ts?: number };
  blocked?: boolean;
}

export interface InboxArchiveEntry {
  id: string;
  kind: string;
  by: string;
  ts: number;
  summary: string;
  where?: string;
}

export interface InboxData {
  items: InboxItem[];
  total: number;
  coverage: string;
  dataErrors: Array<{ type: string; id?: string }>;
  unavailable: boolean;
  decisions: InboxDecision[];
  tasks: InboxTask[];
  reviews: InboxReview[];
  agents: InboxAgent[];
  archive: InboxArchiveEntry[];
  sectionErrors: {
    decisions?: string;
    fleet?: string;
    archive?: string;
  };
  now: number;
}

const PAGE_LIMIT = 200;

export async function getInboxData(space: string): Promise<InboxData> {
  // Not inside the try: a redirect or 404 here must reach Next.js.
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  const opts = { person: viewer.person };

  const [auditRes, homeRes, decRes, logRes] = await Promise.allSettled([
    buildView(viewer.redis, viewer.namespace, 'audit', { limit: PAGE_LIMIT, ...opts }, now),
    buildView(viewer.redis, viewer.namespace, 'home', opts, now),
    buildView(viewer.redis, viewer.namespace, 'decisions', opts, now),
    buildView(viewer.redis, viewer.namespace, 'log', { limit: 120, ...opts }, now),
  ]);

  const sectionErrors: InboxData['sectionErrors'] = {};

  let items: InboxItem[] = [];
  let total = 0;
  let coverage = 'unknown';
  let dataErrors: Array<{ type: string; id?: string }> = [];
  let unavailable = false;

  if (auditRes.status === 'fulfilled') {
    const view: any = auditRes.value;
    const pending = view?.pending ?? { items: [], total: 0 };
    items = (pending.items ?? []).filter((i: InboxItem) => i.type === 'handoff');
    total = Number(pending.total ?? 0);
    coverage = String(view?.coverage ?? 'unknown');
    dataErrors = Array.isArray(view?.data_errors) ? view.data_errors : [];
  } else {
    unavailable = true;
  }

  let agents: InboxAgent[] = [];
  let tasks: InboxTask[] = [];
  let reviews: InboxReview[] = [];
  if (homeRes.status === 'fulfilled') {
    const home: any = homeRes.value;
    agents = Array.isArray(home?.agents) ? home.agents : [];
    const needs = Array.isArray(home?.needs_items) ? home.needs_items : [];
    for (const n of needs) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'task' && n.task) {
        const w = n.task.walkthrough ?? {};
        const steps = Array.isArray(w.steps) ? w.steps : [];
        const done = Array.isArray(n.task.steps_done) ? n.task.steps_done : [];
        tasks.push({
          trail: String(n.task.trail ?? ''),
          summary: String(n.task.summary ?? 'Human task'),
          by: String(n.task.by ?? 'unknown'),
          job: n.job ? String(n.job) : undefined,
          plan: n.plan ? String(n.plan) : undefined,
          due: w.due ? String(w.due) : undefined,
          stepsDone: done.length,
          stepsTotal: steps.length,
        });
      } else if (n.type === 'suggestion' && n.job) {
        reviews.push({
          job: String(n.job),
          summary: String(n.summary ?? n.job),
          evidence: n.evidence ? String(n.evidence) : undefined,
          owner: n.owner ? String(n.owner) : undefined,
          plan: n.plan ? String(n.plan) : undefined,
          created_at: Number(n.created_at) || undefined,
        });
      }
    }
  } else {
    sectionErrors.fleet = 'Fleet and review status could not be loaded right now.';
  }

  let decisions: InboxDecision[] = [];
  if (decRes.status === 'fulfilled') {
    const dv: any = decRes.value;
    const waiting = Array.isArray(dv?.waiting) ? dv.waiting : [];
    decisions = waiting.map((a: any) => ({
      trail: String(a.trail ?? ''),
      summary: String(a.summary ?? 'Untitled decision'),
      by: String(a.by ?? 'unknown'),
      ts: Number(a.ts) || 0,
      where: a.where ? String(a.where) : undefined,
      ask_digest: a.ask_digest ? String(a.ask_digest) : undefined,
      deferred: a.deferred ?? null,
      payload: a.payload ?? {},
    }));
  } else {
    sectionErrors.decisions = 'Open decisions could not be loaded right now.';
  }

  let archive: InboxArchiveEntry[] = [];
  if (logRes.status === 'fulfilled') {
    const lv: any = logRes.value;
    const entries = Array.isArray(lv?.entries) ? lv.entries : [];
    archive = entries
      .filter((e: any) => e && (e.kind === 'accepted' || e.kind === 'done' || e.kind === 'decided'))
      .map((e: any) => ({
        id: String(e.trail ?? `${e.kind}:${e.ts}:${e.by}`),
        kind: String(e.kind),
        by: String(e.by ?? 'unknown'),
        ts: Number(e.ts) || 0,
        summary: String(e.summary ?? ''),
        where: e.where ? String(e.where) : undefined,
      }));
  } else {
    sectionErrors.archive = 'Accepted archive could not be loaded right now.';
  }

  return {
    items,
    total,
    coverage,
    dataErrors,
    unavailable,
    decisions,
    tasks,
    reviews,
    agents,
    archive,
    sectionErrors,
    now,
  };
}
