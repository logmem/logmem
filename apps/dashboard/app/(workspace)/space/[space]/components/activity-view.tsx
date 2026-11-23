'use client';

import { useMemo, useState } from 'react';
import { filterEntriesByGroup, groupCounts } from '../../../../../lib/activity-model.mjs';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { ActivityEntry } from '../../../../../lib/server/activity';
import {
  ActivityTimeline,
  AgeBucketChips,
  CopyId,
  EntryRow,
  KindChip,
  StatePanel,
  type ActivityTimelineEvent,
} from '../../../../../components/ui';

type GroupFilter = 'all' | 'work' | 'handoff' | 'signal' | 'decision' | 'error' | 'system';

const fullWhen = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function entryTone(kind: string | null | undefined): ActivityTimelineEvent['tone'] {
  const k = String(kind || '').toLowerCase();
  if (k === 'done' || k === 'accepted' || k === 'decided') return 'success';
  if (k === 'stuck' || k === 'problem' || k === 'alert') return 'danger';
  if (k === 'progress' || k === 'started' || k === 'handoff' || k === 'approval') return 'brand';
  return 'neutral';
}

export function ActivityView({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  const [group, setGroup] = useState<GroupFilter>('all');
  const [mode, setMode] = useState<'timeline' | 'compact'>('timeline');
  const counts = useMemo(() => groupCounts(entries), [entries]);
  const shown = useMemo(
    () => filterEntriesByGroup(entries, group) as ActivityEntry[],
    [entries, group],
  );

  const options = [
    { id: 'all' as GroupFilter, label: 'All', count: counts.all, alwaysEnabled: true },
    { id: 'work' as GroupFilter, label: 'Work', count: counts.work },
    { id: 'handoff' as GroupFilter, label: 'Handoff', count: counts.handoff },
    { id: 'decision' as GroupFilter, label: 'Decision', count: counts.decision },
    { id: 'signal' as GroupFilter, label: 'Signal', count: counts.signal },
    { id: 'error' as GroupFilter, label: 'Error', count: counts.error },
    { id: 'system' as GroupFilter, label: 'System', count: counts.system },
  ];

  const timelineEvents = useMemo<ActivityTimelineEvent[]>(
    () =>
      shown.map((e) => ({
        id: e.key,
        at: e.ts || now,
        actor: e.actor ?? undefined,
        title: e.summary,
        meta: [e.kind, e.where, e.via ? `via ${e.via}` : null].filter(Boolean).join(' · ') || undefined,
        tone: entryTone(e.kind),
        detail: (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {e.kind ? <KindChip kind={e.kind} /> : null}
              {e.where ? <span className="font-mono text-[11px] text-[var(--text)]">{e.where}</span> : null}
              {e.via ? <span className="font-mono text-[11px] text-[var(--text-subtle)]">via {e.via}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {e.trail ? <CopyId id={e.trail} label="Copy trail" /> : null}
              {e.origin ? <CopyId id={e.origin} label="Copy origin" /> : null}
            </div>
          </div>
        ),
      })),
    [shown, now],
  );

  if (entries.length === 0) {
    return (
      <StatePanel
        variant="empty"
        title="No activity recorded in this space yet."
        detail="Every agent shift start, job update, handoff, and human decision appears here in chronological order."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AgeBucketChips options={options} value={group} onChange={setGroup} ariaLabel="Filter activity by kind group" />
        <div
          role="group"
          aria-label="Activity display mode"
          className="inline-flex rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5 text-xs"
        >
          {(
            [
              ['timeline', 'Timeline'],
              ['compact', 'Compact'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
              className={`rounded-[var(--radius-sm)] px-2.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
                mode === id
                  ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <StatePanel
          variant="empty"
          title="No entries in this filter."
          detail="Switch back to All to see every recorded event in this space."
        />
      ) : mode === 'timeline' ? (
        <ActivityTimeline
          events={timelineEvents}
          now={now}
          timeZone="America/New_York"
          label="Space activity timeline"
        />
      ) : (
        <ul className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
          {shown.map((e) => (
            <EntryRow
              key={e.key}
              timeLabel={e.ts ? relativeTime(e.ts, now) : '—'}
              timeTitle={e.ts ? `${fullWhen.format(e.ts)} ET` : undefined}
              kind={e.kind}
              actor={e.actor}
              summary={e.summary}
              where={e.where}
              trail={e.trail}
              origin={e.origin}
              via={e.via}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
