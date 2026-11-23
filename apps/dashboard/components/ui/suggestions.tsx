'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

type SuggestionsContextValue = {
  onSelect?: (value: string) => void;
};

const SuggestionsContext = React.createContext<SuggestionsContextValue>({});

export interface SuggestionsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  onSelect?: (value: string) => void;
}

export function Suggestions({ className, onSelect, ...props }: SuggestionsProps) {
  return (
    <SuggestionsContext.Provider value={{ onSelect }}>
      <div
        data-slot="suggestions"
        role="group"
        aria-label="Prompt suggestions"
        className={cn('flex flex-col gap-2', className)}
        {...props}
      />
    </SuggestionsContext.Provider>
  );
}

export interface SuggestionListProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export function SuggestionList({
  className,
  orientation = 'horizontal',
  ...props
}: SuggestionListProps) {
  return (
    <div
      data-slot="suggestion-list"
      className={cn(
        'flex gap-2',
        orientation === 'horizontal' ? 'flex-row flex-wrap items-center' : 'flex-col items-start',
        className,
      )}
      {...props}
    />
  );
}

export type SuggestionVariant = 'filled' | 'outline' | 'ghost';

const VARIANT_CLASSES: Record<SuggestionVariant, string> = {
  filled:
    'border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-raised)]',
  outline:
    'border border-[var(--border)] bg-transparent text-[var(--text)] hover:border-[var(--brand)] hover:text-[var(--brand)]',
  ghost:
    'border border-transparent bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
};

export interface SuggestionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value?: string;
  variant?: SuggestionVariant;
}

export function Suggestion({
  className,
  value,
  variant = 'filled',
  onClick,
  children,
  type = 'button',
  ...props
}: SuggestionProps) {
  const { onSelect } = React.useContext(SuggestionsContext);

  return (
    <button
      type={type}
      data-slot="suggestion"
      className={cn(
        'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[var(--radius-pill)] px-3.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-45',
        VARIANT_CLASSES[variant],
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        const text = value ?? (typeof children === 'string' ? children : '');
        if (text && onSelect) onSelect(text);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export default Suggestions;
