'use client';

import { useMemo, useState } from 'react';
import { filterJobsByStage, stageCounts } from '../../../../../lib/work-model.mjs';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { WorkJob } from '../../../../../lib/server/work';
import { AgeBucketChips, CopyId, KindChip, StatePanel } from '../../../../../components/ui';

type StageFilter = 'all' | 'active' | 'blocked' | 'open' | 'done';

const STAGE_KIND: Record<string, string> = {
  active: 'progress',
  blocked: 'stuck',
  open: 'assigned',
  done: 'done',
};

export function WorkView({ jobs, now }: { jobs: WorkJob[]; now: number }) {
  const [stage, setStage] = useState<StageFilter>('all');
  const counts = useMemo(() => stageCounts(jobs), [jobs]);
  const shown = useMemo(() => filterJobsByStage(jobs, stage) as WorkJob[], [jobs, stage]);

  const options = [
    { id: 'all' as StageFilter, label: 'All', count: counts.all, alwaysEnabled: true },
    { id: 'blocked' as StageFilter, label: 'Blocked', count: counts.blocked },
    { id: 'active' as StageFilter, label: 'Active', count: counts.active },
    { id: 'open' as StageFilter, label: 'Open', count: counts.open },
    { id: 'done' as StageFilter, label: 'Done', count: counts.done },
  ];

  if (jobs.length === 0) {
    return (
      <StatePanel
        variant="empty"
        title="No jobs in this space yet."
        detail="Agents open jobs with logmem_assign. Once created, jobs appear here with their owner, plan, and stage."
      />
    );
  }

  return (
    <div className="space-y-4">
      <AgeBucketChips options={options} value={stage} onChange={setStage} ariaLabel="Filter jobs by stage" />

      {shown.length === 0 ? (
        <StatePanel variant="empty" title={`No ${stage} jobs right now.`} />
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
          {shown.map((j) => (
            <li key={j.id} className="space-y-1.5 px-4 py-3 transition-colors hover:bg-[var(--surface-sunken)]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <KindChip kind={STAGE_KIND[j.stage] || j.stage} />
                    <h2 className="break-words text-sm font-semibold text-[var(--text)]">{j.title}</h2>
                  </div>
                  {j.blockedNote ? (
                    <p className="text-xs text-[var(--danger)]">Blocked: {j.blockedNote}</p>
                  ) : j.lastSummary ? (
                    <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{j.lastSummary}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {j.updatedAt ? (
                    <span className="font-mono text-xs tabular-nums text-[var(--text-subtle)] whitespace-nowrap">
                      {relativeTime(j.updatedAt, now)}
                    </span>
                  ) : null}
                  <CopyId id={`job:${j.id}`} label={`Copy job:${j.id}`} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[var(--text-subtle)]">
                <span>owner: {j.owner || 'Unassigned'}</span>
                {j.plan ? <span>plan: {j.plan}</span> : null}
                {j.track ? <span>track: {j.track}</span> : null}
                {j.due ? <span>due: {j.due}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
