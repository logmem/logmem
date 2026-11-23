'use client';

import * as React from 'react';
import { Clock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface DailyTimelineEvent {
  id: string;
  title: string;
  /** Minutes since midnight UTC (0..1439) for deterministic server/client rendering. */
  minutes: number;
  meta?: string | null;
  readOnly?: boolean;
}

export interface DailyTimelineSchedulerProps {
  startHour?: number;
  endHour?: number;
  stepMinutes?: number;
  initialEvents?: DailyTimelineEvent[];
  title?: string;
  subtitle?: string;
  allowLocalAdd?: boolean;
  className?: string;
}

function formatHourMinute(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.floor(totalMinutes)));
  const h24 = Math.floor(clamped / 60);
  const m = clamped % 60;
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function DailyTimelineScheduler({
  startHour = 6,
  endHour = 22,
  stepMinutes = 60,
  initialEvents = [],
  title = 'Daily time slots',
  subtitle = 'UTC slots · local scratchpad items stay in this browser session only.',
  allowLocalAdd = true,
  className,
}: DailyTimelineSchedulerProps) {
  const [events, setEvents] = React.useState<DailyTimelineEvent[]>(initialEvents);
  const [composerHour, setComposerHour] = React.useState<number | null>(null);
  const [draftTitle, setDraftTitle] = React.useState('');
  const [draftMinute, setDraftMinute] = React.useState('00');
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const slots = React.useMemo(() => {
    const out: { hour: number; minute: number; startMin: number }[] = [];
    const safeStep = Math.max(15, Math.min(60, stepMinutes));
    for (let h = startHour; h <= endHour; h += 1) {
      for (let m = 0; m < 60; m += safeStep) {
        if (h === endHour && m > 0) continue;
        out.push({ hour: h, minute: m, startMin: h * 60 + m });
      }
    }
    return out;
  }, [startHour, endHour, stepMinutes]);

  function openAdd(hour: number) {
    setComposerHour(hour);
    setDraftTitle('');
    setDraftMinute('00');
    setEditingId(null);
  }

  function openEdit(ev: DailyTimelineEvent) {
    const h = Math.floor(ev.minutes / 60);
    const m = ev.minutes % 60;
    const snapped = ['00', '15', '30', '45'].includes(String(m).padStart(2, '0'))
      ? String(m).padStart(2, '0')
      : '00';
    setComposerHour(h);
    setDraftTitle(ev.title);
    setDraftMinute(snapped);
    setEditingId(ev.id);
  }

  function saveEvent(e: React.FormEvent) {
    e.preventDefault();
    if (composerHour === null || !draftTitle.trim()) return;
    const minutes = composerHour * 60 + Number(draftMinute);
    if (editingId) {
      setEvents((prev) =>
        prev.map((ev) => (ev.id === editingId ? { ...ev, title: draftTitle.trim(), minutes } : ev)),
      );
    } else {
      setEvents((prev) => [
        ...prev,
        {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: draftTitle.trim(),
          minutes,
          meta: 'local note',
          readOnly: false,
        },
      ]);
    }
    setComposerHour(null);
    setDraftTitle('');
    setEditingId(null);
  }

  function deleteEvent(id: string) {
    setEvents((prev) => prev.filter((ev) => ev.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setComposerHour(null);
    }
  }

  return (
    <section
      data-slot="daily-timeline-scheduler"
      className={cn(
        'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]',
        className,
      )}
    >
      <header className="border-b border-[var(--border)] px-4 py-3">
        <h3 className="font-heading text-sm font-semibold text-[var(--text)]">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-[var(--text-subtle)]">{subtitle}</p> : null}
      </header>

      <div className="max-h-[420px] divide-y divide-[var(--border)] overflow-y-auto px-4">
        {slots.map(({ hour, minute, startMin }) => {
          const nextMin = startMin + Math.max(15, Math.min(60, stepMinutes));
          const slotEvents = events.filter((ev) => ev.minutes >= startMin && ev.minutes < nextMin);
          const isComposing = composerHour === hour;

          return (
            <div key={`${hour}-${minute}`} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-medium tabular-nums text-[var(--text-muted)]">
                  {formatHourMinute(startMin)} UTC
                </span>
                {allowLocalAdd ? (
                  <button
                    type="button"
                    onClick={() => (isComposing ? setComposerHour(null) : openAdd(hour))}
                    className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-xs font-medium text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  >
                    {isComposing ? (
                      <>
                        <X aria-hidden="true" className="size-3" />
                        Close
                      </>
                    ) : (
                      <>
                        <Plus aria-hidden="true" className="size-3" />
                        Note
                      </>
                    )}
                  </button>
                ) : null}
              </div>

              {isComposing ? (
                <form
                  onSubmit={saveEvent}
                  className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5"
                >
                  <label htmlFor={`slot-title-${hour}`} className="sr-only">
                    Note title
                  </label>
                  <input
                    id={`slot-title-${hour}`}
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    placeholder="Add local slot note…"
                    className="min-w-[160px] flex-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  />
                  <label htmlFor={`slot-min-${hour}`} className="sr-only">
                    Minute
                  </label>
                  <select
                    id={`slot-min-${hour}`}
                    value={draftMinute}
                    onChange={(e) => setDraftMinute(e.target.value)}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  >
                    {['00', '15', '30', '45'].map((m) => (
                      <option key={m} value={m}>
                        :{m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="rounded-[var(--radius-sm)] bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                  >
                    {editingId ? 'Update' : 'Save'}
                  </button>
                </form>
              ) : null}

              {slotEvents.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {slotEvents.map((ev) => (
                    <li
                      key={ev.id}
                      className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Clock aria-hidden="true" className="size-3 shrink-0 text-[var(--brand)]" />
                        <span className="shrink-0 font-mono tabular-nums text-[var(--text-subtle)]">
                          {formatHourMinute(ev.minutes)}
                        </span>
                        <span className="truncate font-medium text-[var(--text)]">{ev.title}</span>
                        {ev.meta ? (
                          <span className="hidden truncate font-mono text-[11px] text-[var(--text-subtle)] sm:inline">
                            · {ev.meta}
                          </span>
                        ) : null}
                      </div>
                      {!ev.readOnly ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Edit ${ev.title}`}
                            onClick={() => openEdit(ev)}
                            className="rounded-[var(--radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                          >
                            <Pencil aria-hidden="true" className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${ev.title}`}
                            onClick={() => deleteEvent(ev.id)}
                            className="rounded-[var(--radius-sm)] p-1 text-[var(--danger)] hover:bg-[var(--danger-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                          >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default DailyTimelineScheduler;
