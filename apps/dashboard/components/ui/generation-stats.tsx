'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export type GenerationFinishReason = 'stop' | 'stopped' | 'error' | 'rules' | (string & {});

export interface GenerationStatsProps extends React.ComponentProps<'div'> {
  model?: string;
  ttftMs?: number;
  durationMs?: number;
  wordCount?: number;
  finishReason?: GenerationFinishReason;
  live?: boolean;
}

export function formatGenerationTime(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`;
}

export function GenerationStats({
  model,
  ttftMs,
  durationMs,
  wordCount,
  finishReason,
  live = false,
  className,
  ...props
}: GenerationStatsProps) {
  const parts: React.ReactNode[] = [];

  if (model) {
    parts.push(
      <span key="model" className="font-mono text-[var(--text-muted)]">
        {model}
      </span>,
    );
  }
  if (ttftMs !== undefined) {
    parts.push(
      <span key="ttft" className="tabular-nums">
        TTFT {formatGenerationTime(ttftMs)}
      </span>,
    );
  }
  if (durationMs !== undefined) {
    parts.push(
      <span key="dur" className="tabular-nums">
        {formatGenerationTime(durationMs)}
      </span>,
    );
  }
  if (wordCount !== undefined && wordCount > 0) {
    parts.push(
      <span key="words" className="tabular-nums">
        {wordCount} {wordCount === 1 ? 'word' : 'words'}
      </span>,
    );
  }

  if (live) {
    parts.push(
      <span key="live" className="inline-flex items-center gap-1 text-[var(--brand)]">
        <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
        <span>Streaming</span>
      </span>,
    );
  } else if (finishReason) {
    const isErr = finishReason === 'error';
    const isStopped = finishReason === 'stopped';
    parts.push(
      <span
        key="finish"
        className={cn(
          'inline-flex items-center gap-1',
          isErr ? 'text-[var(--danger)]' : isStopped ? 'text-[var(--warning)]' : 'text-[var(--success)]',
        )}
      >
        {isErr ? (
          <AlertCircle aria-hidden="true" className="size-3" />
        ) : (
          <CheckCircle2 aria-hidden="true" className="size-3" />
        )}
        <span>{isErr ? 'Error' : isStopped ? 'Stopped' : 'Complete'}</span>
      </span>,
    );
  }

  if (parts.length === 0) return null;

  return (
    <div
      data-slot="generation-stats"
      aria-busy={live || undefined}
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[var(--text-subtle)]',
        className,
      )}
      {...props}
    >
      {parts.map((part, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 ? <span aria-hidden="true">·</span> : null}
          {part}
        </React.Fragment>
      ))}
    </div>
  );
}

export default GenerationStats;
