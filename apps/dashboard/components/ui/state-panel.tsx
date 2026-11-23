import type { ReactNode } from 'react';

export function StatePanel({
  variant,
  title,
  detail,
  action,
}: {
  variant: 'error' | 'empty';
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  const isError = variant === 'error';
  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={`rounded-[var(--radius-md)] border p-4 text-sm ${
        isError
          ? 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]'
          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
      }`}
    >
      <p className={`font-semibold ${isError ? 'text-[var(--danger)]' : 'text-[var(--text)]'}`}>
        {title}
      </p>
      {detail ? <p className="mt-1">{detail}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function PageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-6 font-sans" aria-busy="true" aria-label="Loading">
      <div className="border-b border-[var(--border)] pb-4 space-y-2">
        <div className="lm-skeleton h-7 w-36" />
        <div className="lm-skeleton h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2"
          >
            <div className="lm-skeleton h-3 w-16" />
            <div className="lm-skeleton h-6 w-12" />
          </div>
        ))}
      </div>
      <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <div className="lm-skeleton h-4 w-16 shrink-0" />
            <div className="lm-skeleton h-4 flex-1" />
            <div className="lm-skeleton h-4 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
