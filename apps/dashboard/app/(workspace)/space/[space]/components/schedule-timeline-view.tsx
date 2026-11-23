'use client';

import * as React from 'react';
import Link from 'next/link';
import { Clock, Terminal } from 'lucide-react';
import {
  CopyId,
  Slider,
  Timeline,
  TimelineCurrentTime,
  TimelineGrid,
  TimelineHeader,
  TimelineProvider,
  TimelineRow,
  TimelineSlot,
  TimelineSlotContent,
  TimelineSlotLabel,
  type TimelineConfig,
  type TimelineRowData,
  type TimelineSlotData,
} from '../../../../../components/ui';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import { cn } from '../../../../../lib/utils';

export interface ShiftTimelineRow extends TimelineRowData {
  surface: string;
  state: string;
  statusLabel: string;
}

export interface ShiftTimelineSlot extends TimelineSlotData {
  agent: string;
  surface: string;
  state: string;
  statusLabel: string;
  doing: string | null;
  startedAt: number;
}

interface ScheduleTimelineViewProps {
  space: string;
  rows: ShiftTimelineRow[];
  slots: ShiftTimelineSlot[];
  config: TimelineConfig;
  now: number;
}

function stateBorderClass(state: string) {
  if (state === 'active') return 'border-l-[3px] border-l-[var(--success)]';
  if (state === 'idle') return 'border-l-[3px] border-l-[var(--brand)]';
  return 'border-l-[3px] border-l-[var(--border-strong)]';
}

function stateDotClass(state: string) {
  if (state === 'active') return 'bg-[var(--success)]';
  if (state === 'idle') return 'bg-[var(--brand)]';
  return 'bg-[var(--text-subtle)]';
}

export function ScheduleTimelineView({
  space,
  rows,
  slots,
  config,
  now,
}: ScheduleTimelineViewProps) {
  const [percentageInView, setPercentageInView] = React.useState(100);
  const [selectedId, setSelectedId] = React.useState<string | null>(slots[0]?.id ?? null);

  const selected = React.useMemo(
    () => slots.find((s) => s.id === selectedId) ?? null,
    [slots, selectedId],
  );

  if (rows.length === 0 || slots.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-muted)]">
          {[
            ['Active', 'active'],
            ['Idle', 'idle'],
            ['Quiet', 'quiet'],
          ].map(([label, key]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className={cn('size-2 rounded-full', stateDotClass(key))} />
              {label}
            </span>
          ))}
          <span className="font-mono text-[11px] text-[var(--text-subtle)]">UTC · read-only recorded shifts</span>
        </div>

        <div className="flex w-full max-w-[220px] items-center gap-3">
          <label
            htmlFor="schedule-zoom-slider"
            className="shrink-0 font-mono text-[11px] font-medium tabular-nums text-[var(--text-subtle)]"
          >
            Zoom {Math.round((100 / percentageInView) * 100)}%
          </label>
          <Slider
            id="schedule-zoom-slider"
            aria-label="Timeline zoom level"
            min={50}
            max={100}
            step={5}
            value={[percentageInView]}
            onValueChange={(val) => setPercentageInView(val[0] ?? 100)}
          />
        </div>
      </div>

      <TimelineProvider
        config={config}
        percentageInView={percentageInView}
        onSlotClick={(id) => setSelectedId(id)}
      >
        <Timeline slots={slots} rows={rows}>
          <TimelineGrid>
            <TimelineHeader columnLabel="Agent" />
            {rows.map((row) => (
              <TimelineRow
                key={row.id}
                row={row}
                slots={slots}
                renderRowHeader={(r) => {
                  const typed = r as ShiftTimelineRow;
                  return (
                    <div className="min-w-0 px-3 py-1.5">
                      <Link
                        href={`/space/${encodeURIComponent(space)}/agents/${encodeURIComponent(typed.id)}`}
                        className="block truncate text-xs font-semibold text-[var(--text)] hover:text-[var(--link)] hover:underline"
                      >
                        {typed.label}
                      </Link>
                      <div className="flex items-center gap-1 truncate font-mono text-[10px] text-[var(--text-subtle)]">
                        <Terminal aria-hidden="true" className="size-2.5 shrink-0" />
                        <span className="truncate">{typed.surface}</span>
                      </div>
                    </div>
                  );
                }}
              >
                {(slot) => {
                  const s = slot as ShiftTimelineSlot;
                  return (
                    <TimelineSlot
                      key={s.id}
                      slot={s}
                      selected={selectedId === s.id}
                      ariaLabel={`${s.agent} shift started at ${s.startTime} UTC via ${s.surface}`}
                      className={cn('px-2 py-1', stateBorderClass(s.state))}
                    >
                      <TimelineSlotLabel>{s.doing || `Shift via ${s.surface}`}</TimelineSlotLabel>
                      <TimelineSlotContent className="mt-0.5 flex items-center gap-1.5">
                        <Clock aria-hidden="true" className="size-2.5 shrink-0" />
                        <span>{s.startTime}</span>
                        <span>· {s.statusLabel}</span>
                      </TimelineSlotContent>
                    </TimelineSlot>
                  );
                }}
              </TimelineRow>
            ))}
            <TimelineCurrentTime nowLabel="Now" nowTs={now} />
          </TimelineGrid>
        </Timeline>
      </TimelineProvider>

      {selected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-sm">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span aria-hidden="true" className={cn('size-2 rounded-full', stateDotClass(selected.state))} />
              <span className="font-semibold text-[var(--text)]">{selected.agent}</span>
              <span className="font-mono text-xs text-[var(--text-subtle)]">
                via {selected.surface} · started {relativeTime(selected.startedAt, now)} ({selected.startTime} UTC)
              </span>
            </div>
            <p className="truncate text-xs text-[var(--text-muted)]">
              {selected.doing || 'No active task recorded for this shift.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CopyId id={`agent:${selected.agent}`} label={`Copy agent:${selected.agent}`} />
            <Link
              href={`/space/${encodeURIComponent(space)}/agents/${encodeURIComponent(selected.agent)}`}
              className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:text-[var(--link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              Inspect agent →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
