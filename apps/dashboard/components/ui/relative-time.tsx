'use client';

import * as React from 'react';
import { createContext, type HTMLAttributes, useContext, useEffect, useState } from 'react';
import { cn } from '../../lib/utils';

const formatDate = (
  date: Date,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat(
    'en-US',
    options ?? {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    },
  ).format(date);

const formatTime = (
  date: Date,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat(
    'en-US',
    options ?? {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone,
    },
  ).format(date);

type RelativeTimeContextType = {
  time: Date;
  dateFormatOptions?: Intl.DateTimeFormatOptions;
  timeFormatOptions?: Intl.DateTimeFormatOptions;
};

const RelativeTimeContext = createContext<RelativeTimeContextType>({
  time: new Date(0),
});

export type RelativeTimeProps = HTMLAttributes<HTMLDivElement> & {
  time?: Date;
  defaultTime?: Date;
  onTimeChange?: (time: Date) => void;
  dateFormatOptions?: Intl.DateTimeFormatOptions;
  timeFormatOptions?: Intl.DateTimeFormatOptions;
  /** Set false to freeze clock (useful for static snapshots). Defaults to true. */
  tick?: boolean;
};

export const RelativeTime = ({
  time: controlledTime,
  defaultTime,
  onTimeChange,
  dateFormatOptions,
  timeFormatOptions,
  tick = true,
  className,
  ...props
}: RelativeTimeProps) => {
  const [internalTime, setInternalTime] = useState<Date>(() => defaultTime ?? new Date());
  const activeTime = controlledTime ?? internalTime;

  useEffect(() => {
    if (!tick || controlledTime) return;
    const interval = window.setInterval(() => {
      const next = new Date();
      setInternalTime(next);
      onTimeChange?.(next);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [tick, controlledTime, onTimeChange]);

  return (
    <RelativeTimeContext.Provider
      value={{
        time: activeTime,
        dateFormatOptions,
        timeFormatOptions,
      }}
    >
      <div data-slot="relative-time" className={cn('grid gap-2', className)} {...props} />
    </RelativeTimeContext.Provider>
  );
};

export type RelativeTimeZoneProps = HTMLAttributes<HTMLDivElement> & {
  zone: string;
};

const RelativeTimeZoneContext = createContext<{ zone: string }>({ zone: 'UTC' });

export const RelativeTimeZone = ({ zone, className, ...props }: RelativeTimeZoneProps) => (
  <RelativeTimeZoneContext.Provider value={{ zone }}>
    <div
      data-slot="relative-time-zone"
      className={cn('flex items-center justify-between gap-2 text-xs text-[var(--text)]', className)}
      {...props}
    />
  </RelativeTimeZoneContext.Provider>
);

export const RelativeTimeZoneDisplay = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const { time, timeFormatOptions } = useContext(RelativeTimeContext);
  const { zone } = useContext(RelativeTimeZoneContext);
  return (
    <div
      suppressHydrationWarning
      className={cn('font-mono tabular-nums text-[var(--text)]', className)}
      {...props}
    >
      {formatTime(time, zone, timeFormatOptions)}
    </div>
  );
};

export const RelativeTimeZoneDate = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const { time, dateFormatOptions } = useContext(RelativeTimeContext);
  const { zone } = useContext(RelativeTimeZoneContext);
  return (
    <div
      suppressHydrationWarning
      className={cn('text-[var(--text-muted)]', className)}
      {...props}
    >
      {formatDate(time, zone, dateFormatOptions)}
    </div>
  );
};

export const RelativeTimeZoneLabel = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'inline-flex h-5 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 font-mono text-[11px] font-medium text-[var(--text-muted)]',
      className,
    )}
    {...props}
  />
);
