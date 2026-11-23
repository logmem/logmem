'use client';

import * as React from 'react';
import { useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, CircleDot } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface ActivityTimelineEvent {
  id: string;
  /** Epoch milliseconds or ISO timestamp. */
  at: string | number;
  /** Who wrote the entry, shown first in foreground ink. */
  actor?: string;
  /** Primary summary text. */
  title: string;
  /** Short metadata under the title (e.g., kind · job). */
  meta?: string;
  /** Expandable content revealed in place when the row is clicked or activated via Enter/Space. */
  detail?: React.ReactNode;
  /** Optional custom icon for the timeline marker. */
  icon?: React.ReactNode;
  /** Semantic tone; never the sole carrier of status. */
  tone?: 'neutral' | 'success' | 'danger' | 'brand';
}

export interface ActivityTimelineProps {
  events: ActivityTimelineEvent[];
  now: number;
  label: string;
  timeZone?: string;
  locale?: string;
  maxHeight?: number | string;
  defaultExpanded?: string[];
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  className?: string;
}

type Row = ActivityTimelineEvent & { time: number; day: string };
type Group = { day: string; label: string; rows: Row[] };

const HOUR = 3_600_000;

function dayKey(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(time));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function relativeLabel(time: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return { short: 'Now', long: 'just now' };
  if (minutes < 60) {
    return {
      short: `${minutes}m`,
      long: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`,
    };
  }
  const hours = Math.floor(minutes / 60);
  return {
    short: `${hours}h`,
    long: `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`,
  };
}

function MarkerIcon({ tone, icon }: { tone: ActivityTimelineEvent['tone']; icon?: React.ReactNode }) {
  if (icon) return <>{icon}</>;
  if (tone === 'success') return <CheckCircle2 aria-hidden="true" className="size-3.5" />;
  if (tone === 'danger') return <AlertCircle aria-hidden="true" className="size-3.5" />;
  return <CircleDot aria-hidden="true" className="size-3.5" />;
}

const MARKER_TONE: Record<NonNullable<ActivityTimelineEvent['tone']>, string> = {
  neutral: 'border-[var(--border-strong)] bg-[var(--surface-sunken)] text-[var(--text-muted)]',
  brand: 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]',
  success: 'border-[var(--success)] bg-[var(--success-subtle)] text-[var(--success)]',
  danger: 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]',
};

function ActivityRow({
  row,
  last,
  expanded,
  onToggle,
  timeLabel,
  timeFull,
}: {
  row: Row;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  timeLabel: string;
  timeFull: string;
}) {
  const detailId = useId();
  const tone = row.tone ?? 'neutral';

  const rowHeader = (
    <>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm leading-snug text-[var(--text-muted)]">
          {row.actor ? (
            <span className="font-semibold text-[var(--text)]">{row.actor} </span>
          ) : null}
          <span className="text-[var(--text)]">{row.title}</span>
        </span>
        {row.meta ? (
          <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--text-subtle)]">
            {row.meta}
          </span>
        ) : null}
      </span>
      <time
        className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-subtle)]"
        dateTime={new Date(row.time).toISOString()}
        title={timeFull}
      >
        <span aria-hidden="true">{timeLabel}</span>
        <span className="sr-only">{timeFull}</span>
      </time>
      {row.detail ? (
        <span
          aria-hidden="true"
          className={cn(
            'shrink-0 text-[var(--text-subtle)] transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
        >
          <ChevronDown className="size-4" />
        </span>
      ) : null}
    </>
  );

  return (
    <li data-slot="activity-timeline-item" className="relative flex items-start gap-3 pb-3 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 mt-1 flex size-7 shrink-0 items-center justify-center rounded-full border',
          MARKER_TONE[tone],
        )}
      >
        <MarkerIcon tone={tone} icon={row.icon} />
      </span>
      {!last ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[13px] top-8 bottom-0 w-px bg-[var(--border)]"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        {row.detail ? (
          <button
            type="button"
            data-timeline-trigger=""
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
          >
            {rowHeader}
          </button>
        ) : (
          <div className="flex w-full items-start gap-2.5 px-2.5 py-1.5">{rowHeader}</div>
        )}

        {expanded && row.detail ? (
          <div
            id={detailId}
            className="mt-1.5 ml-2.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 text-xs text-[var(--text-muted)]"
          >
            {row.detail}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function ActivityTimeline({
  events,
  now,
  label,
  timeZone = 'UTC',
  locale = 'en-US',
  maxHeight,
  defaultExpanded = [],
  headingLevel = 3,
  className,
}: ActivityTimelineProps) {
  const id = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));

  const groups = useMemo<Group[]>(() => {
    const today = dayKey(now, timeZone);
    const yesterday = dayKey(now - 24 * HOUR, timeZone);
    const heading = new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone,
    });
    const byDay = new Map<string, Row[]>();
    [...events]
      .map((event) => ({ ...event, time: new Date(event.at).getTime() }))
      .filter((event) => Number.isFinite(event.time) && event.time > 0)
      .sort((a, b) => b.time - a.time)
      .forEach((event) => {
        const day = dayKey(event.time, timeZone);
        const list = byDay.get(day);
        if (list) list.push({ ...event, day });
        else byDay.set(day, [{ ...event, day }]);
      });
    return [...byDay].map(([day, rows]) => ({
      day,
      rows,
      label:
        day === today
          ? 'Today'
          : day === yesterday
            ? 'Yesterday'
            : heading.format(new Date(rows[0].time)),
    }));
  }, [events, now, timeZone, locale]);

  const formats = useMemo(
    () => ({
      clock: new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }),
      full: new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone,
      }),
    }),
    [locale, timeZone],
  );

  function toggle(rowId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const triggers = [
      ...(scrollerRef.current?.querySelectorAll<HTMLElement>('[data-timeline-trigger]') ?? []),
    ];
    const index = triggers.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? triggers.length - 1
          : Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), triggers.length - 1);
    triggers[next]?.focus();
  }

  return (
    <div
      data-slot="activity-timeline"
      role="region"
      aria-label={label}
      className={cn(
        'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]',
        className,
      )}
    >
      <div
        ref={scrollerRef}
        onKeyDown={onKeyDown}
        className={cn('px-4 py-3', maxHeight !== undefined && 'overflow-y-auto')}
        style={
          maxHeight !== undefined
            ? { maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }
            : undefined
        }
      >
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.day} aria-labelledby={`${id}-${group.day}`} className="space-y-2.5">
              <div
                id={`${id}-${group.day}`}
                role="heading"
                aria-level={headingLevel}
                className="sticky top-0 z-20 -mx-4 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-1.5"
              >
                <span className="font-heading text-xs font-semibold uppercase tracking-wide text-[var(--text)]">
                  {group.label}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-[var(--text-subtle)]">
                  {group.rows.length} {group.rows.length === 1 ? 'update' : 'updates'}
                </span>
              </div>

              <ol className="space-y-0.5">
                {group.rows.map((row, index) => {
                  const isToday = group.label === 'Today' && now - row.time < 12 * HOUR;
                  const time = isToday
                    ? relativeLabel(row.time, now)
                    : { short: formats.clock.format(new Date(row.time)), long: '' };
                  const timeFull = isToday
                    ? `${time.long}, ${formats.full.format(new Date(row.time))}`
                    : formats.full.format(new Date(row.time));

                  return (
                    <ActivityRow
                      key={row.id}
                      row={row}
                      last={index === group.rows.length - 1}
                      expanded={expanded.has(row.id)}
                      onToggle={() => toggle(row.id)}
                      timeLabel={time.short}
                      timeFull={timeFull}
                    />
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ActivityTimeline;
