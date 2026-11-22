import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { normalizeJobs } from '../work-model.mjs';

export interface WorkJob {
  id: string;
  title: string;
  stage: string;
  owner: string | null;
  plan: string | null;
  track: string | null;
  due: string | null;
  blockedNote: string | null;
  lastSummary: string | null;
  updatedAt: number | null;
}

export interface WorkData {
  jobs: WorkJob[];
  unavailable: boolean;
  now: number;
}

export async function getWorkData(space: string): Promise<WorkData> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const view: any = await buildView(viewer.redis, viewer.namespace, 'jobs', {}, now);
    return { jobs: normalizeJobs(view?.jobs), unavailable: false, now };
  } catch {
    return { jobs: [], unavailable: true, now };
  }
}
