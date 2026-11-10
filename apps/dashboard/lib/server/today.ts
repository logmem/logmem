// apps/dashboard/lib/server/today.ts
// Today data: the home view, read in process through the viewer's read-only
// jailed runner (same path as lib/server/inbox.ts and the root customer app).
// Identity and membership come from requireSpace. No HTTP hop, no new credential.
import 'server-only';
import { buildView } from '../../../../src/http/view.mjs';
import { requireSpace } from './auth';

// Row shapes built by lib/today-model.mjs.
export interface NeedRow {
  key: string; type: string; label: string; summary: string; job: string | null; plan: string | null;
  by: string | null; due: string | null; createdAt: number | null; progress: string | null;
}
export interface BlockedRow {
  key: string; title: string; owner: string | null; plan: string | null; reason: string; since: number | null;
}
export interface RecentRow {
  key: string; summary: string; by: string | null; where: string | null; kind: string | null; ts: number;
}

export interface TodayData {
  view: any | null;
  unavailable: boolean;
  now: number;
}

export async function getTodayData(space: string): Promise<TodayData> {
  // Not inside the try: a redirect here must reach Next.js.
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const view = await buildView(viewer.redis, viewer.namespace, 'home', { person: viewer.person }, now);
    return { view, unavailable: false, now };
  } catch {
    // Say the data is unavailable. Never show an empty Today as if it were true.
    return { view: null, unavailable: true, now };
  }
}
