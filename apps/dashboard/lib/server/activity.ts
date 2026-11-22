import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';
import { normalizeEntries } from '../activity-model.mjs';

export interface ActivityEntry {
  key: string;
  ts: number;
  kind: string;
  group: string;
  actor: string;
  summary: string;
  where: string | null;
  trail: string | null;
  origin: string | null;
  via: string | null;
}

export interface ActivityData {
  entries: ActivityEntry[];
  coverageNote: string | null;
  unavailable: boolean;
  now: number;
}

export async function getActivityData(space: string): Promise<ActivityData> {
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const view: any = await buildView(viewer.redis, viewer.namespace, 'log', { limit: 200 }, now);
    return {
      entries: normalizeEntries(view?.entries),
      coverageNote: view?.coverage?.note ? String(view.coverage.note) : null,
      unavailable: false,
      now,
    };
  } catch {
    return { entries: [], coverageNote: null, unavailable: true, now };
  }
}
