'use client';

import { useMemo, useState } from 'react';
import { filterEntriesByGroup, groupCounts } from '../../../../../lib/activity-model.mjs';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { ActivityEntry } from '../../../../../lib/server/activity';
import { AgeBucketChips, EntryRow, StatePanel } from '../../../../../components/ui';

type GroupFilter = 'all' | 'work' | 'handoff' | 'signal' | 'decision' | 'error' | 'system';

const fullWhen = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function ActivityView({ entries, now }: { entries: ActivityEntry[]; now: number }) {
  const [group, setGroup] = useState<GroupFilter>('all');
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
      <AgeBucketChips options={options} value={group} onChange={setGroup} ariaLabel="Filter activity by kind group" />

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
    </div>
  );
}
