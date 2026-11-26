import Link from 'next/link';
import { requireSpace } from '../../../../../lib/server/auth';
import { getTodayData } from '../../../../../lib/server/today';
import type { BlockedRow, NeedRow, RecentRow } from '../../../../../lib/server/today';
import { relativeTime, shortName } from '../../../../../lib/inbox-model.mjs';
import {
  blockedRows, coverageNotice, needsRows, recentRows, todayCounts,
} from '../../../../../lib/today-model.mjs';
import {
  ChronoBoard, CopyId, KindChip, PageHeader, StatTile, StatePanel, StatusStrip,
  type ChronoTone,
} from '../../../../../components/ui';
import { ImportBanner } from '../components/import-banner';

export const dynamic = 'force-dynamic';

const panel = 'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]';

export default async function TodayPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  // Cached per request: getTodayData reuses this check.
  await requireSpace(space, 'read');
  const { view, unavailable, now } = await getTodayData(space);

  if (unavailable || !view) {
    return (
      <div className="space-y-6 font-sans">
        <PageHeader title="Brief" subtitle={`space:${space}`} />
        <StatePanel
          variant="error"
          title="LogMem could not read this space."
          detail="Nothing is shown because an empty page would be wrong. Reload to try again."
        />
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
      <PageHeader
        title="Brief"
        subtitle={`space:${space}`}
        actions={
          <Link
            href={`/space/${space}/inbox`}
            className="inline-flex min-h-[36px] items-center rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
          >
            Open Inbox
          </Link>
        }
      />

      <ImportBanner space={space} receipt={(view as any)?.import_receipt} />

      {notice ? (
        <StatusStrip
          message={notice}
          tone="warning"
          storageKey={`lm-brief-notice:${space}:${notice}`}
        />
      ) : null}

      <section aria-label="Summary" className="lm-stat-grid">
        <StatTile
          label="Decisions"
          value={counts.decisions}
          note={counts.decisions === 0 ? 'none waiting' : 'need your approval'}
          href={`/space/${space}/inbox`}
          tone={counts.decisions > 0 ? 'warning' : 'default'}
        />
        <StatTile
          label="Tasks"
          value={counts.tasks}
          note={counts.tasks === 0 ? 'none waiting' : 'need a person'}
          href={`/space/${space}/inbox`}
        />
        <StatTile
          label="Waiting"
          value={counts.waiting}
          note={counts.waiting === 0 ? 'no blocked jobs' : 'blocked jobs'}
          href={`/space/${space}/work`}
          tone={counts.waiting > 0 ? 'danger' : 'default'}
        />
        <StatTile
          label="Done"
          value={counts.done}
          note={`of ${counts.jobs} jobs`}
          href={`/space/${space}/work`}
        />
      </section>

      <section aria-labelledby="needs-h" className="space-y-2">
        <h2 id="needs-h" className="font-heading text-lg font-semibold text-[var(--text)]">
          Needs your attention ({needs.length})
        </h2>
        {needs.length === 0 ? (
          <StatePanel
            variant="empty"
            title="Nothing in this space needs you now."
            detail="Pending decisions and person-blocked tasks appear here as soon as agents raise them."
          />
        ) : (
          <ul className={`${panel} divide-y divide-[var(--border)]`}>
            {needs.map((n) => (
              <li
                key={n.key}
                className="flex min-h-[44px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm"
              >
                <KindChip kind={n.type === 'decision' ? 'approval' : 'stuck'} />
                <span className="min-w-0 flex-1 basis-60 text-[var(--text)]">{n.summary}</span>
                <span className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                  {n.job ? <CopyId id={n.job} /> : null}
                  <span>
                    {[
                      n.by ? `from ${shortName(n.by)}` : null,
                      n.progress ? `${n.progress} steps` : null,
                      n.due ? `due ${n.due}` : null,
                      n.createdAt ? relativeTime(n.createdAt, now) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="waiting-h" className={panel}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 id="waiting-h" className="font-heading text-sm font-semibold text-[var(--text)]">
            Waiting work ({counts.waiting})
          </h2>
          {counts.waiting > blocked.length ? (
            <Link className="text-xs font-medium text-[var(--link)] hover:underline" href={`/space/${space}/work`}>
              View all in Work →
            </Link>
          ) : null}
        </div>
        {blocked.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--text-muted)]">No job in this space is blocked.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {blocked.map((b) => (
              <li key={b.key} className="px-4 py-3 text-sm">
                <div className="font-medium text-[var(--text)]">{b.title}</div>
                <div className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {[
                    b.reason,
                    b.owner ? `owner ${shortName(b.owner)}` : 'no owner',
                    b.since ? `blocked ${relativeTime(b.since, now)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="recent-h" className={panel}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 id="recent-h" className="font-heading text-sm font-semibold text-[var(--text)]">
            Recent updates ({recent.length})
          </h2>
          <Link className="text-xs font-medium text-[var(--link)] hover:underline" href={`/space/${space}/activity`}>
            View all activity →
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="px-4 py-3 text-sm text-[var(--text-muted)]">
            No job in this space has an update yet.
          </p>
        ) : (
          <div className="p-4">
            <ChronoBoard
              label="Recent space updates"
              cards={recent.map((e, idx) => {
                const kind = String(e.kind || 'memo').toLowerCase();
                const tone: ChronoTone =
                  kind === 'done' || kind === 'accepted'
                    ? 'success'
                    : kind === 'stuck' || kind === 'problem' || kind === 'alert'
                      ? 'danger'
                      : kind === 'approval' || kind === 'handoff'
                        ? 'warning'
                        : kind === 'progress' || kind === 'started'
                          ? 'brand'
                          : 'neutral';
                return {
                  id: e.key,
                  title: e.summary,
                  date: relativeTime(e.ts, now),
                  status: e.kind || 'update',
                  tone,
                  active: idx === 0,
                  meta: [e.by ? shortName(e.by) : null, e.where].filter(Boolean).join(' · ') || null,
                };
              })}
            />
          </div>
        )}
      </section>
    </div>
  );
}
