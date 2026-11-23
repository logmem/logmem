'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface HeatStripBucket {
  count: number;
  label: string;
  hasRecap?: boolean;
}

export interface HeatStripProps extends React.ComponentProps<'div'> {
  buckets: HeatStripBucket[];
  unitLabel?: string;
  showSummary?: boolean;
  height?: number;
}

/**
 * 21st.dev Heat Strip (id: 29464) adapted to LogMem tokens:
 * thin vertical intensity bars answering "is this alive?" at a glance.
 */
export function HeatStrip({
  buckets,
  unitLabel = 'bucket',
  showSummary = true,
  height = 44,
  className,
  ...props
}: HeatStripProps) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const latest = buckets[buckets.length - 1]?.count ?? 0;

  return (
    <div className={cn('grid gap-2', className)} {...props}>
      {showSummary ? (
        <p className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs tabular-nums text-[var(--text-subtle)]">
          <span>
            total{' '}
            <strong className="font-semibold text-[var(--text)]">
              {total.toLocaleString('en-US')}
            </strong>
          </span>
          <span>
            peak{' '}
            <strong className="font-semibold text-[var(--text)]">
              {max.toLocaleString('en-US')}
            </strong>
            /{unitLabel}
          </span>
          <span>
            latest{' '}
            <strong className="font-semibold text-[var(--text)]">
              {latest.toLocaleString('en-US')}
            </strong>
          </span>
        </p>
      ) : null}

      <div
        className="flex items-end gap-0.5"
        style={{ height }}
        role="img"
        aria-label={`${total} events across ${buckets.length} intervals, peak ${max}`}
      >
        {buckets.map((b, i) => {
          const ratio = b.count / max;
          const barH = b.count > 0 ? Math.max(4, Math.round(ratio * height)) : 3;
          return (
            <div
              key={i}
              title={`${b.label}: ${b.count} ${b.count === 1 ? 'entry' : 'entries'}${b.hasRecap ? ' · recap' : ''}`}
              className="group relative flex h-full min-w-0 flex-1 items-end"
            >
              <span
                className={cn(
                  'block w-full rounded-t-[2px] transition-opacity duration-150 group-hover:opacity-100',
                  b.count > 0
                    ? 'bg-[var(--brand)]'
                    : 'bg-[var(--border)] opacity-55',
                )}
                style={{
                  height: barH,
                  opacity: b.count > 0 ? 0.3 + 0.7 * ratio : undefined,
                }}
              />
              {b.hasRecap ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-[var(--success)]"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default HeatStrip;
