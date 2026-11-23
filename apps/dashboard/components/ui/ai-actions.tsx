'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface ActionsProps extends React.ComponentProps<'div'> {
  label?: string;
}

export function Actions({ className, label = 'Message actions', children, ...props }: ActionsProps) {
  return (
    <div
      data-slot="ai-actions"
      role="toolbar"
      aria-label={label}
      className={cn('inline-flex flex-wrap items-center gap-1', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export interface ActionProps extends React.ComponentProps<'button'> {
  label: string;
  active?: boolean;
}

export function Action({
  label,
  active = false,
  className,
  children,
  type = 'button',
  ...props
}: ActionProps) {
  return (
    <button
      type={type}
      data-slot="ai-action"
      title={label}
      aria-label={label}
      aria-pressed={active ? true : undefined}
      className={cn(
        'inline-flex h-7 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-[var(--radius-sm)] border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-45',
        active
          ? 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]'
          : 'border-transparent bg-transparent text-[var(--text-subtle)] hover:border-[var(--border)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export default Actions;
