import Link from 'next/link';
import { requireSpace } from '../../../../../lib/server/auth';
import { getTodayData } from '../../../../../lib/server/today';
import type { BlockedRow, NeedRow, RecentRow } from '../../../../../lib/server/today';
import { relativeTime, shortName } from '../../../../../lib/inbox-model.mjs';
import {
  blockedRows, coverageNotice, needsRows, recentRows, todayCounts,
} from '../../../../../lib/today-model.mjs';

export const dynamic = 'force-dynamic';

const line = 'border-[#D3DAD8] dark:border-[#2B3835]';
const muted = 'text-[#46534F] dark:text-[#B3BEBA]';
const panel = `rounded border ${line} bg-white dark:bg-[#121A19]`;

function Count({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex min-h-[44px] items-baseline gap-2 px-3 py-2">
      <span className="text-xl font-bold tabular-nums">{value}</span>
      <span className={`text-sm ${muted}`}>{label}{note ? ` ${note}` : ''}</span>
    </div>
  );
}

export default async function TodayPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  // Cached per request: getTodayData reuses this check.
  await requireSpace(space, 'read');
  const { view, unavailable, now } = await getTodayData(space);

  const heading = (
    <div className={`pb-4 border-b ${line}`}>
      <h1 className="text-2xl md:text-3xl font-['Schibsted_Grotesk'] font-bold">Today</h1>
    </div>
  );

  if (unavailable || !view) {
    return (
      <div className="space-y-4 font-sans">
        {heading}
        <p role="alert" className={`${panel} p-4 text-sm`}>
          LogMem could not read this space. Nothing is shown, because an empty page would be wrong. Reload to try again.
        </p>
      </div>
    );
  }

  const counts = todayCounts(view);
  const needs: NeedRow[] = needsRows(view);
  const blocked: BlockedRow[] = blockedRows(view);
  const recent: RecentRow[] = recentRows(view);
  const notice = coverageNotice(view);

  return (
    <div className="space-y-6 font-sans">
      {heading}

      <section aria-label="Summary" className={`${panel} sticky top-0 z-10 flex flex-wrap divide-x divide-[#D3DAD8] dark:divide-[#2B3835]`}>
        <Count label="Decisions" value={counts.decisions} />
        <Count label="Tasks" value={counts.tasks} />
        <Count label="Waiting" value={counts.waiting} />
        <Count label="Done" value={counts.done} note={`of ${counts.jobs} jobs`} />
      </section>

      {notice ? <p role="status" className={`${panel} p-3 text-sm`}>{notice}</p> : null}

      <section aria-labelledby="needs-h" className="space-y-2">
        <h2 id="needs-h" className="text-lg font-semibold">Needs your attention ({needs.length})</h2>
        {needs.length === 0 ? (
          <p className={`text-sm ${muted}`}>Nothing in this space needs you now.</p>
        ) : (
          <ul className={`${panel} divide-y divide-[#D3DAD8] dark:divide-[#2B3835]`}>
            {needs.map((n) => (
              <li key={n.key} className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className={`shrink-0 rounded border ${line} px-2 py-0.5 text-xs font-semibold`}>{n.label}</span>
                <span className="min-w-0 flex-1 basis-60">{n.summary}</span>
                <span className={`shrink-0 text-xs ${muted}`}>
                  {[n.job, n.by ? `from ${shortName(n.by)}` : null, n.progress ? `${n.progress} steps` : null, n.due ? `due ${n.due}` : null, n.createdAt ? relativeTime(n.createdAt, now) : null]
                    .filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className={panel} open={blocked.length > 0 && blocked.length <= 4}>
        <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-sm font-semibold">
          Waiting work ({counts.waiting})
        </summary>
        {blocked.length === 0 ? (
          <p className={`px-3 pb-3 text-sm ${muted}`}>No job in this space is blocked.</p>
        ) : (
          <ul className="divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
            {blocked.map((b) => (
              <li key={b.key} className="px-3 py-2 text-sm">
                <div className="font-medium">{b.title}</div>
                <div className={`text-xs ${muted}`}>
                  {[b.reason, b.owner ? `owner ${shortName(b.owner)}` : 'no owner', b.since ? `blocked ${relativeTime(b.since, now)}` : null]
                    .filter(Boolean).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}
        {counts.waiting > blocked.length ? (
          <p className={`px-3 py-2 text-xs ${muted}`}>
            Showing {blocked.length} of {counts.waiting}.{' '}
            <Link className="underline" href={`/space/${space}/work`}>Open Work</Link>
          </p>
        ) : null}
      </details>

      <details className={panel}>
        <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-sm font-semibold">
          Recent updates ({recent.length})
        </summary>
        {recent.length === 0 ? (
          <p className={`px-3 pb-3 text-sm ${muted}`}>No job in this space has an update yet.</p>
        ) : (
          <ul className="divide-y divide-[#D3DAD8] dark:divide-[#2B3835]">
            {recent.map((e) => (
              <li key={e.key} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 basis-60">{e.summary}</span>
                <span className={`shrink-0 text-xs ${muted}`}>
                  {[e.by ? shortName(e.by) : null, e.where, relativeTime(e.ts, now)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
