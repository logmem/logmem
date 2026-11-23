'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Clock, Zap } from 'lucide-react';
import { cn } from '../../lib/utils';

export type ChronoTone = 'success' | 'brand' | 'warning' | 'danger' | 'neutral';

export interface DisplayCardProps {
  id?: string;
  icon?: React.ReactNode;
  title: string;
  description?: string | null;
  date?: string | null;
  status: string;
  tone?: ChronoTone;
  active?: boolean;
  meta?: string | null;
  actions?: React.ReactNode;
  isLast?: boolean;
}

const TONE_DOT: Record<ChronoTone, string> = {
  success: 'bg-[var(--success)] text-[var(--text-inverse)]',
  brand: 'bg-[var(--brand)] text-[var(--on-brand)]',
  warning: 'bg-[var(--warning)] text-[var(--text-inverse)]',
  danger: 'bg-[var(--danger)] text-[var(--text-inverse)]',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-muted)] border border-[var(--border-strong)]',
};

const TONE_BADGE: Record<ChronoTone, string> = {
  success: 'bg-[var(--success-subtle)] text-[var(--success)]',
  brand: 'bg-[var(--brand-subtle)] text-[var(--brand)]',
  warning: 'bg-[var(--warning-subtle)] text-[var(--warning)]',
  danger: 'bg-[var(--danger-subtle)] text-[var(--danger)]',
  neutral: 'bg-[var(--surface-sunken)] text-[var(--text-muted)]',
};

function DefaultToneIcon({ tone }: { tone: ChronoTone }) {
  if (tone === 'success') return <CheckCircle2 aria-hidden="true" className="size-3.5" />;
  if (tone === 'warning' || tone === 'danger') return <AlertTriangle aria-hidden="true" className="size-3.5" />;
  if (tone === 'brand') return <Zap aria-hidden="true" className="size-3.5" />;
  return <Clock aria-hidden="true" className="size-3.5" />;
}

export function DisplayCard({
  icon,
  title,
  description,
  date,
  status,
  tone = 'neutral',
  active = false,
  meta,
  actions,
  isLast = false,
}: DisplayCardProps) {
  return (
    <li data-slot="chrono-card" className="group relative flex items-start gap-x-3.5">
      {!isLast ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[11px] top-6 -bottom-4 w-px bg-[var(--border)]"
        />
      ) : null}

      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full transition-colors',
          active ? TONE_DOT[tone] : 'border border-[var(--border-strong)] bg-[var(--surface-sunken)] text-[var(--text-muted)] group-hover:border-[var(--brand)] group-hover:text-[var(--brand)]',
        )}
      >
        {icon ?? <DefaultToneIcon tone={tone} />}
      </span>

      <div
        className={cn(
          'min-w-0 flex-1 rounded-[var(--radius-md)] border p-3.5 transition-colors',
          active
            ? 'border-[var(--border-strong)] bg-[var(--surface-raised)] shadow-sm'
            : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]',
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm font-semibold text-[var(--text)]">{title}</p>
          {date ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-subtle)]">{date}</span>
          ) : null}
        </div>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'rounded-[var(--radius-pill)] px-2 py-0.5 font-mono text-[11px] font-medium',
                TONE_BADGE[tone],
              )}
            >
              {status}
            </span>
            {meta ? (
              <span className="font-mono text-[11px] text-[var(--text-subtle)]">{meta}</span>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
        </div>
      </div>
    </li>
  );
}

export interface DisplayCardsProps {
  cards: DisplayCardProps[];
  label?: string;
  className?: string;
}

export function DisplayCards({ cards, label = 'Chronological updates', className }: DisplayCardsProps) {
  return (
    <ol aria-label={label} data-slot="chrono-board" className={cn('relative w-full space-y-3', className)}>
      {cards.map((cardProps, index) => (
        <DisplayCard
          key={cardProps.id ?? `${cardProps.title}-${index}`}
          {...cardProps}
          isLast={index === cards.length - 1}
        />
      ))}
    </ol>
  );
}

export { DisplayCards as ChronoBoard };
export default DisplayCards;
