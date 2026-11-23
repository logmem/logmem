import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { normalizeAgents } from '../agents-model.mjs';

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  state: string;
  statusLabel: string;
  doing: string | null;
  blocked: boolean;
  job: string | null;
  surface: string | null;
  recapSummary: string | null;
  recapMode: string | null;
  lastTs: number | null;
}

export interface AgentsData {
  agents: AgentRow[];
  unavailable: boolean;
  now: number;
}

export async function getAgentsData(space: string): Promise<AgentsData> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const view: any = await buildView(viewer.redis, viewer.namespace, 'agents', {}, now);
    return { agents: normalizeAgents(view?.agents), unavailable: false, now };
  } catch {
    return { agents: [], unavailable: true, now };
  }
}
