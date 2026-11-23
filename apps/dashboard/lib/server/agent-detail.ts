import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { buildAgentDetail, validAgentId } from '../agent-detail-model.mjs';
import type { AgentStatusTask } from '../../components/ui/agent-status';
import type { TraceSpan } from '../../components/ui/agent-trace';

export interface AgentDetailSpan extends TraceSpan {
  summary?: string;
  trail?: string | null;
  ts?: number;
  entryKind?: string;
}

export interface AgentDetailModel {
  id: string;
  name: string;
  role: string | null;
  skills: string[];
  state: string;
  statusLabel: string;
  doing: string | null;
  next: string | null;
  blocked: boolean;
  job: string | null;
  plan: string | null;
  surface: string | null;
  recap: {
    summary: string;
    mode: string | null;
    endedAt: number | null;
    next: string[];
  } | null;
  follows: string[];
  ownedJobs: { id: string; title: string; stage: string; plan: string | null }[];
  handoffs: { id: string; by: string; summary: string; ts: number; where: string | null }[];
  shifts: { id: string; surface: string; startedAt: number; endedAt: number | null; entryCount: number }[];
  log: { id: string; kind: string; summary: string; ts: number; where: string | null; via: string | null }[];
  statusTasks: AgentStatusTask[];
  trace: {
    runId: string;
    model: string | null;
    duration: number;
    spans: AgentDetailSpan[];
  };
}

export interface AgentDetailResult {
  agent: AgentDetailModel | null;
  invalid: boolean;
  unavailable: boolean;
  now: number;
}

export async function getAgentDetailData(space: string, rawAgentId: string): Promise<AgentDetailResult> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  const decoded = decodeURIComponent(rawAgentId || '').replace(/^agent:/, '');
  if (!validAgentId(decoded)) {
    return { agent: null, invalid: true, unavailable: false, now };
  }
  try {
    const [agentView, jobsView]: any[] = await Promise.all([
      buildView(viewer.redis, viewer.namespace, 'agent', { id: decoded }, now),
      buildView(viewer.redis, viewer.namespace, 'jobs', {}, now),
    ]);
    const agent = buildAgentDetail(agentView, jobsView?.jobs, now) as AgentDetailModel | null;
    return { agent, invalid: false, unavailable: false, now };
  } catch {
    return { agent: null, invalid: false, unavailable: true, now };
  }
}
