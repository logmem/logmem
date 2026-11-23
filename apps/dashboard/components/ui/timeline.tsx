'use client';

import * as React from 'react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

/* ============================================================================
 * TYPES & INTERFACES
 * ========================================================================== */

export interface TimelineSlotData {
  id: string;
  rowId: string;
  startTime: string; // "HH:MM"
  duration: number; // minutes
  [key: string]: unknown;
}

export interface TimelineRowData {
  id: string;
  label: string;
  [key: string]: unknown;
}

export interface TimelineConfig {
  startHour: number;
  endHour: number;
  snapIntervalMinutes?: number;
  columnWidth?: number;
}

/* ============================================================================
 * CONTEXT
 * ========================================================================== */

type TimelineContextValue = {
  config: TimelineConfig;
  pixelsPerMinute: number;
  timelineWidth: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  columnRef: React.RefObject<HTMLDivElement | null>;
  onSlotClick?: (slotId: string) => void;
};

const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimeline() {
  const context = useContext(TimelineContext);
  if (!context) {
    throw new Error('Timeline components must be used within TimelineProvider');
  }
  return context;
}

/* ============================================================================
 * UTILITIES
 * ========================================================================== */

export const timeToMinutes = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

export const minutesToTime = (minutes: number): string => {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.floor(minutes)));
  const hours = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

/* ============================================================================
 * TIMELINE PROVIDER
 * ========================================================================== */

export interface TimelineProviderProps {
  children: React.ReactNode;
  config: TimelineConfig;
  percentageInView?: number;
  onSlotClick?: (slotId: string) => void;
  style?: React.CSSProperties;
  className?: string;
}

export function TimelineProvider({
  children,
  config,
  percentageInView = 100,
  onSlotClick,
  style,
  className,
}: TimelineProviderProps) {
  const [viewportWidth, setViewportWidth] = useState(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const columnWidth = config.columnWidth ?? 136;

  useEffect(() => {
    const measure = () => {
      if (timelineRef.current) {
        setViewportWidth(Math.max(320, timelineRef.current.clientWidth - columnWidth));
      }
    };
    measure();
    window.addEventListener('resize', measure);
    const timeout = window.setTimeout(measure, 100);
    return () => {
      window.removeEventListener('resize', measure);
      window.clearTimeout(timeout);
    };
  }, [columnWidth]);

  const totalMinutes = Math.max(60, (config.endHour - config.startHour) * 60);
  const safePercent = Math.max(25, Math.min(100, percentageInView));
  const basePixelsPerMinute = viewportWidth > 0 ? viewportWidth / totalMinutes : 1.5;
  const pixelsPerMinute = basePixelsPerMinute * (100 / safePercent);
  const timelineWidth = Math.round(totalMinutes * pixelsPerMinute);

  const contextValue: TimelineContextValue = {
    config,
    pixelsPerMinute,
    timelineWidth,
    timelineRef,
    columnRef,
    onSlotClick,
  };

  return (
    <TimelineContext.Provider value={contextValue}>
      <div
        data-slot="timeline-wrapper"
        style={
          {
            '--timeline-column-width': `${columnWidth}px`,
            '--timeline-width': `${timelineWidth}px`,
            '--timeline-pixels-per-minute': pixelsPerMinute,
            ...style,
          } as React.CSSProperties
        }
        className={cn('relative w-full', className)}
      >
        {children}
      </div>
    </TimelineContext.Provider>
  );
}

/* ============================================================================
 * TIMELINE (Read-only Scrollable Container with Hover Time Cursor)
 * ========================================================================== */

export interface TimelineProps {
  slots: TimelineSlotData[];
  rows: TimelineRowData[];
  children: React.ReactNode;
  className?: string;
}

export function Timeline({ children, className }: TimelineProps) {
  const { config, pixelsPerMinute, timelineRef } = useTimeline();
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);
  const columnWidth = config.columnWidth ?? 136;

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + timelineRef.current.scrollLeft;
    if (x < columnWidth) {
      setMousePosition(null);
      return;
    }
    setMousePosition({ x, y: e.clientY - rect.top });
  };

  const handleMouseLeave = () => {
    setMousePosition(null);
  };

  const mouseTime = mousePosition
    ? minutesToTime(
        Math.floor((mousePosition.x - columnWidth) / pixelsPerMinute) + config.startHour * 60,
      )
    : null;

  return (
    <div className="relative w-full">
      <div
        ref={timelineRef}
        data-slot="timeline-grid"
        className={cn(
          'relative overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]',
          className,
        )}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {mousePosition && mouseTime ? (
          <TimelineMouseIndicator mouseX={mousePosition.x} time={mouseTime} />
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* ============================================================================
 * TIMELINE GRID
 * ========================================================================== */

export interface TimelineGridProps {
  children: React.ReactNode;
  className?: string;
}

export function TimelineGrid({ children, className }: TimelineGridProps) {
  const { config, timelineWidth } = useTimeline();
  const columnWidth = config.columnWidth ?? 136;

  return (
    <div
      data-slot="timeline-grid-container"
      className={cn('relative', className)}
      style={{ minWidth: `${timelineWidth + columnWidth}px` }}
    >
      {children}
    </div>
  );
}

/* ============================================================================
 * TIMELINE HEADER
 * ========================================================================== */

export interface TimelineHeaderProps {
  className?: string;
  columnLabel?: React.ReactNode;
}

export function TimelineHeader({ className, columnLabel = 'Agent' }: TimelineHeaderProps) {
  const { config, pixelsPerMinute, columnRef } = useTimeline();

  const totalHours = Math.max(1, config.endHour - config.startHour);
  const stepHours = totalHours >= 18 && pixelsPerMinute < 1 ? 2 : 1;
  const hourMarkers: { hour: number; label: string; position: number }[] = [];
  for (let hour = config.startHour; hour < config.endHour; hour += stepHours) {
    hourMarkers.push({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      position: (hour - config.startHour) * 60 * pixelsPerMinute,
    });
  }

  return (
    <div
      data-slot="timeline-header"
      className={cn('sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-sunken)]', className)}
    >
      <div className="flex h-10">
        <div
          ref={columnRef}
          data-slot="timeline-header-column"
          className="sticky left-0 z-20 flex w-[var(--timeline-column-width)] shrink-0 items-center border-r border-[var(--border)] bg-[var(--surface-sunken)] px-3 font-mono text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]"
        >
          {columnLabel}
        </div>
        <div data-slot="timeline-header-markers" className="relative flex-1">
          {hourMarkers.map((marker) => (
            <div
              key={marker.hour}
              data-slot="timeline-hour-marker"
              className="absolute inset-y-0 flex items-center pl-1.5 font-mono text-[11px] tabular-nums text-[var(--text-subtle)]"
              style={{ left: `${marker.position}px` }}
            >
              {marker.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * TIMELINE ROW
 * ========================================================================== */

export interface TimelineRowProps {
  row: TimelineRowData;
  slots: TimelineSlotData[];
  children: (slot: TimelineSlotData) => React.ReactNode;
  renderRowHeader?: (row: TimelineRowData) => React.ReactNode;
  className?: string;
}

export function TimelineRow({
  row,
  slots,
  children,
  renderRowHeader,
  className,
}: TimelineRowProps) {
  const { config, pixelsPerMinute, timelineWidth } = useTimeline();
  const rowSlots = slots.filter((s) => s.rowId === row.id);

  const hourMarkers: { hour: number; position: number }[] = [];
  for (let hour = config.startHour; hour <= config.endHour; hour++) {
    hourMarkers.push({
      hour,
      position: (hour - config.startHour) * 60 * pixelsPerMinute,
    });
  }

  const showQuarterLines = pixelsPerMinute >= 1.2;
  const quarterHourMarkers: { position: number }[] = [];
  if (showQuarterLines) {
    const totalMinutes = (config.endHour - config.startHour) * 60;
    for (let minutes = 15; minutes < totalMinutes; minutes += 15) {
      if (minutes % 60 !== 0) {
        quarterHourMarkers.push({ position: minutes * pixelsPerMinute });
      }
    }
  }

  return (
    <div
      data-slot="timeline-row"
      className={cn(
        'flex min-h-14 border-b border-[var(--border)] bg-[var(--surface)] last:border-b-0',
        className,
      )}
    >
      <div
        data-slot="timeline-row-label"
        className="sticky left-0 z-[5] flex w-[var(--timeline-column-width)] shrink-0 items-center border-r border-[var(--border)] bg-[var(--surface)]"
      >
        {renderRowHeader ? renderRowHeader(row) : <span className="truncate px-3 text-sm font-medium text-[var(--text)]">{row.label}</span>}
      </div>

      <div
        data-slot="timeline-row-grid"
        className="relative flex-1"
        style={{ width: `${timelineWidth}px` }}
      >
        {quarterHourMarkers.map((marker, idx) => (
          <div
            key={`quarter-${idx}`}
            aria-hidden="true"
            data-slot="timeline-grid-line-quarter"
            className="pointer-events-none absolute inset-y-0 w-px bg-[var(--border)] opacity-35"
            style={{ left: `${marker.position}px` }}
          />
        ))}
        {hourMarkers.map((marker) => (
          <div
            key={marker.hour}
            aria-hidden="true"
            data-slot="timeline-grid-line-hour"
            className="pointer-events-none absolute inset-y-0 w-px bg-[var(--border)] opacity-80"
            style={{ left: `${marker.position}px` }}
          />
        ))}

        {rowSlots.map((slot) => (
          <React.Fragment key={slot.id}>{children(slot)}</React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ============================================================================
 * TIMELINE SLOT (Read-only Accessible Button/Surface)
 * ========================================================================== */

export interface TimelineSlotProps {
  slot: TimelineSlotData;
  children: React.ReactNode;
  className?: string;
  selected?: boolean;
  ariaLabel?: string;
}

export function TimelineSlot({
  slot,
  children,
  className,
  selected = false,
  ariaLabel,
}: TimelineSlotProps) {
  const { config, pixelsPerMinute, onSlotClick } = useTimeline();

  const startMinutes = timeToMinutes(slot.startTime);
  const clampedStart = Math.max(config.startHour * 60, startMinutes);
  const left = (clampedStart - config.startHour * 60) * pixelsPerMinute;
  const width = Math.max(slot.duration * pixelsPerMinute, 56);

  const sharedClasses = cn(
    'absolute inset-y-1.5 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] text-left transition-colors',
    onSlotClick &&
      'cursor-pointer hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
    selected && 'ring-2 ring-[var(--brand)]',
    className,
  );

  const slotStyle = {
    left: `${left}px`,
    width: `${width}px`,
    '--slot-start-time': slot.startTime,
    '--slot-duration': `${slot.duration}min`,
  } as React.CSSProperties;

  if (onSlotClick) {
    return (
      <button
        type="button"
        data-slot="timeline-slot"
        data-selected={selected ? 'true' : undefined}
        aria-label={ariaLabel}
        onClick={() => onSlotClick(slot.id)}
        className={sharedClasses}
        style={slotStyle}
      >
        {children}
      </button>
    );
  }

  return (
    <div data-slot="timeline-slot" className={sharedClasses} style={slotStyle}>
      {children}
    </div>
  );
}

/* ============================================================================
 * TIMELINE SLOT PRIMITIVES
 * ========================================================================== */

export function TimelineSlotLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="timeline-slot-label"
      className={cn('truncate text-xs font-semibold leading-tight text-[var(--text)]', className)}
      {...props}
    />
  );
}

export function TimelineSlotContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="timeline-slot-content"
      className={cn('truncate font-mono text-[11px] tabular-nums text-[var(--text-muted)]', className)}
      {...props}
    />
  );
}

/* ============================================================================
 * TIMELINE INDICATORS
 * ========================================================================== */

export function TimelineMouseIndicator({ mouseX, time }: { mouseX: number; time: string }) {
  return (
    <div
      aria-hidden="true"
      data-slot="timeline-mouse-indicator"
      className="pointer-events-none absolute inset-y-0 z-20"
      style={{ left: `${mouseX}px` }}
    >
      <div className="absolute inset-y-0 left-0 w-px bg-[var(--brand)] opacity-60" />
      <div className="absolute top-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] bg-[var(--brand)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-[var(--on-brand)] shadow-sm">
        {time}
      </div>
    </div>
  );
}

export interface TimelineCurrentTimeProps {
  className?: string;
  nowLabel?: string;
  nowTs?: number;
}

export function TimelineCurrentTime({
  className,
  nowLabel = 'Now',
  nowTs,
}: TimelineCurrentTimeProps) {
  const { config, pixelsPerMinute } = useTimeline();
  const columnWidth = config.columnWidth ?? 136;
  const [now, setNow] = useState<Date>(() => (nowTs ? new Date(nowTs) : new Date()));

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (currentMinutes < config.startHour * 60 || currentMinutes > config.endHour * 60) {
    return null;
  }

  const position = (currentMinutes - config.startHour * 60) * pixelsPerMinute + columnWidth;

  return (
    <div
      aria-hidden="true"
      data-slot="timeline-current-time"
      className={cn(
        'pointer-events-none absolute inset-y-0 z-[15] w-0.5 bg-[var(--brand)]',
        className,
      )}
      style={{ left: `${position}px` }}
    >
      <div className="absolute top-0.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-raised)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-[var(--text)] shadow-sm">
        {nowLabel} {minutesToTime(currentMinutes)}
      </div>
    </div>
  );
}

export default Timeline;
