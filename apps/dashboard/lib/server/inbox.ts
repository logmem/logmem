// apps/dashboard/lib/server/inbox.ts
// Inbox data: the audit view's pending handoffs, read in process through the
// viewer's read-only jailed runner (same path as lib/server/today.ts).
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

export interface InboxData {
  items: InboxItem[];
  total: number;
  coverage: string;
  dataErrors: Array<{ type: string; id?: string }>;
  unavailable: boolean;
  now: number;
}

// The audit view caps one page at 200 items. The screen pages 10 at a time on its own.
const PAGE_LIMIT = 200;

export async function getInboxData(space: string): Promise<InboxData> {
  // Not inside the try: a redirect or 404 here must reach Next.js.
  const viewer = await requireSpace(space, 'read');
  const now = Date.now();
  try {
    const view: any = await buildView(
      viewer.redis,
      viewer.namespace,
      'audit',
      { limit: PAGE_LIMIT, person: viewer.person },
      now,
    );
    const pending = view?.pending ?? { items: [], total: 0 };
    return {
      items: (pending.items ?? []).filter((i: InboxItem) => i.type === 'handoff'),
      total: Number(pending.total ?? 0),
      coverage: String(view?.coverage ?? 'unknown'),
      dataErrors: Array.isArray(view?.data_errors) ? view.data_errors : [],
      unavailable: false,
      now,
    };
  } catch {
    // Say the data is unavailable. Never show an empty inbox as if it were true.
    return { items: [], total: 0, coverage: 'unknown', dataErrors: [], unavailable: true, now };
  }
}
