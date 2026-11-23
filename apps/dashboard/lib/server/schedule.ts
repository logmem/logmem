import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { buildSchedule } from '../schedule-model.mjs';

export interface ScheduleShift {
  id: string;
  agent: string;
  surface: string;
  startedAt: number;
  lastAt: number;
  state: string;
  statusLabel: string;
  doing: string | null;
}

export interface ScheduleDueItem {
  id: string;
  title: string;
  due: string;
  isMilestone: boolean;
  owner: string | null;
  stage: string;
  plan: string | null;
}

export interface ScheduleData {
  shifts: ScheduleShift[];
  upcoming: ScheduleDueItem[];
  unavailable: boolean;
  now: number;
}

export async function getScheduleData(space: string): Promise<ScheduleData> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const [agentsView, jobsView]: any[] = await Promise.all([
      buildView(viewer.redis, viewer.namespace, 'agents', {}, now),
      buildView(viewer.redis, viewer.namespace, 'jobs', {}, now),
    ]);
    const { shifts, upcoming } = buildSchedule(agentsView?.agents, jobsView?.jobs);
    return { shifts, upcoming, unavailable: false, now };
  } catch {
    return { shifts: [], upcoming: [], unavailable: true, now };
  }
}
