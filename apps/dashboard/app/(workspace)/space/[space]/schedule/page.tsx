import { requireSpace } from '../../../../../lib/server/auth';
import { getScheduleData } from '../../../../../lib/server/schedule';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import { CopyId, KindChip, PageHeader, StatePanel } from '../../../../../components/ui';

export const dynamic = 'force-dynamic';

export default async function SchedulePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const { shifts, upcoming, unavailable, now } = await getScheduleData(space);

  if (unavailable) {
    return (
      <div className="space-y-6 font-sans">
        <PageHeader title="Schedule" subtitle={`space:${space}`} />
        <StatePanel
          variant="error"
          title="Schedule data could not be read right now."
          detail="Nothing is shown because an empty schedule would be wrong. Reload to try again."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Schedule"
        subtitle={`Recorded shifts and dated milestones in space:${space}.`}
      />

      <section aria-labelledby="sched-due-h" className="space-y-2">
        <h2 id="sched-due-h" className="font-heading text-lg font-semibold text-[var(--text)]">
          Upcoming due dates and milestones ({upcoming.length})
        </h2>
        {upcoming.length === 0 ? (
          <StatePanel
            variant="empty"
            title="No open dated jobs or milestones in this space."
            detail="Jobs opened with a due date or milestone date appear here in chronological order."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            {upcoming.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <KindChip kind={item.isMilestone ? 'approval' : item.stage === 'blocked' ? 'stuck' : 'assigned'} />
                    <span className="font-medium text-[var(--text)]">{item.title}</span>
                  </div>
                  <div className="font-mono text-xs text-[var(--text-subtle)]">
                    {[item.owner ? `owner ${item.owner}` : 'Unassigned', item.plan ? `plan ${item.plan}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-xs font-semibold tabular-nums text-[var(--text)]">
                    {item.due}
                  </span>
                  <CopyId id={`job:${item.id}`} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sched-shifts-h" className="space-y-2">
        <h2 id="sched-shifts-h" className="font-heading text-lg font-semibold text-[var(--text)]">
          Recent agent shifts ({shifts.length})
        </h2>
        {shifts.length === 0 ? (
          <StatePanel
            variant="empty"
            title="No recorded shifts yet."
            detail="When an agent calls logmem_start, its active and recent shifts appear here."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            {shifts.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[var(--text)]">{s.agent}</span>
                    <span className="font-mono text-xs text-[var(--text-subtle)]">via {s.surface}</span>
                    <span className="rounded-[var(--radius-pill)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                      {s.statusLabel}
                    </span>
                  </div>
                  {s.doing ? <p className="truncate text-xs text-[var(--text-muted)]">{s.doing}</p> : null}
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                  started {relativeTime(s.startedAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
