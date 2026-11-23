'use client';

import * as React from 'react';
import { CheckCircle2, Circle, ListTodo, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface AgentStatusTask {
  id: string;
  label: string;
  status: 'complete' | 'pending' | 'running';
  meta?: string | null;
}

export interface AgentStatusProps extends React.ComponentProps<'section'> {
  detail?: string | null;
  tasks?: AgentStatusTask[];
  title: string;
  badge?: string | null;
}

function TaskStatus({ status }: Pick<AgentStatusTask, 'status'>) {
  if (status === 'complete') {
    return (
      <CheckCircle2
        aria-label="Complete"
        className="size-3.5 text-[var(--success)]"
      />
    );
  }
  if (status === 'running') {
    return (
      <Loader2
        aria-label="Running"
        className="size-3.5 animate-spin text-[var(--brand)] motion-reduce:animate-none"
      />
    );
  }
  return <Circle aria-label="Pending" className="size-3 text-[var(--text-subtle)]" />;
}

export function AgentStatus({
  className,
  detail,
  tasks = [],
  title,
  badge,
  ...props
}: AgentStatusProps) {
  const complete = tasks.filter((task) => task.status === 'complete').length;

  return (
    <section
      data-slot="agent-status"
      className={cn(
        'rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4 font-sans text-sm text-[var(--text-muted)]',
        className,
      )}
      {...props}
    >
      <header className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]"
        >
          <ListTodo className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-heading text-sm font-semibold text-[var(--text)]">{title}</h2>
            {badge ? (
              <span className="rounded-[var(--radius-pill)] bg-[var(--brand-subtle)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--brand)]">
                {badge}
              </span>
            ) : null}
          </div>
          {detail ? <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{detail}</p> : null}
        </div>
        {tasks.length > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-subtle)]">
            {complete}/{tasks.length}
          </span>
        ) : null}
      </header>

      {tasks.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] p-2">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-xs leading-5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <TaskStatus status={task.status} />
                </span>
                <span
                  className={cn(
                    'truncate',
                    task.status === 'complete' ? 'text-[var(--text-subtle)] line-through' : 'text-[var(--text)]',
                  )}
                >
                  {task.label}
                </span>
              </div>
              {task.meta ? (
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-subtle)]">{task.meta}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default AgentStatus;
