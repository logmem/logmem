'use client';

import * as React from 'react';
import { ArrowUp, BookOpen, ExternalLink, Square } from 'lucide-react';
import { cn } from '../../lib/utils';

export type CitedStatus = 'idle' | 'reading' | 'answering' | 'done';

export interface CitedSource {
  id: string;
  title: string;
  domain?: string;
  href?: string;
  tone?: 1 | 2 | 3 | 4 | 5;
}

const REF_RE = /\b((?:job|agent|channel):[a-zA-Z0-9._-]+|trail:[a-zA-Z0-9._-]+)\b/g;

/** Extract real LogMem entity citations referenced in an assistant reply. Never invents sources. */
export function extractLogmemSources(text: string, space?: string): CitedSource[] {
  const seen = new Set<string>();
  const out: CitedSource[] = [];
  for (const match of text.matchAll(REF_RE)) {
    const raw = match[1];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const [kind, ...rest] = raw.split(':');
    const id = rest.join(':');
    let href: string | undefined;
    if (space) {
      const sp = encodeURIComponent(space);
      if (kind === 'agent') href = `/space/${sp}/agents/${encodeURIComponent(id)}`;
      else if (kind === 'job') href = `/space/${sp}/work`;
      else if (kind === 'channel') href = `/space/${sp}/activity`;
    }
    out.push({
      id: raw,
      title: raw,
      domain: kind,
      href,
      tone: (((out.length % 5) + 1) as 1 | 2 | 3 | 4 | 5),
    });
    if (out.length >= 6) break;
  }
  return out;
}

export interface CitedSourcesBarProps {
  sources: CitedSource[];
  activeSource?: string | null;
  onActiveSourceChange?: (id: string | null) => void;
  onSourceClick?: (source: CitedSource) => void;
}

export function CitedSourcesBar({
  sources,
  activeSource,
  onActiveSourceChange,
  onSourceClick,
}: CitedSourcesBarProps) {
  if (sources.length === 0) return null;
  return (
    <div data-slot="cited-sources" className="mt-2 space-y-1.5">
      <div className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--text-subtle)]">
        <BookOpen aria-hidden="true" className="size-3" />
        <span>
          {sources.length} {sources.length === 1 ? 'referenced record' : 'referenced records'}
        </span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((src, idx) => {
          const highlighted = activeSource === src.id;
          const inner = (
            <>
              <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--brand-subtle)] font-mono text-[10px] font-semibold text-[var(--brand)]">
                {idx + 1}
              </span>
              <span className="truncate font-mono text-[11px] text-[var(--text)]">{src.title}</span>
              {src.href ? <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-[var(--text-subtle)]" /> : null}
            </>
          );
          const cls = cn(
            'inline-flex max-w-[220px] items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]',
            highlighted
              ? 'border-[var(--brand)] bg-[var(--brand-subtle)]'
              : 'border-[var(--border)] bg-[var(--surface-sunken)] hover:border-[var(--border-strong)]',
          );
          return (
            <li key={src.id}>
              {src.href ? (
                <a
                  href={src.href}
                  onMouseEnter={() => onActiveSourceChange?.(src.id)}
                  onMouseLeave={() => onActiveSourceChange?.(null)}
                  className={cls}
                >
                  {inner}
                </a>
              ) : (
                <button
                  type="button"
                  onMouseEnter={() => onActiveSourceChange?.(src.id)}
                  onMouseLeave={() => onActiveSourceChange?.(null)}
                  onClick={() => onSourceClick?.(src)}
                  className={cls}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface CitedAnswerChatInputProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  footerNote?: string;
  maxLength?: number;
  className?: string;
}

export function CitedAnswerChatInput({
  value,
  onValueChange,
  onSubmit,
  onStop,
  busy = false,
  disabled = false,
  placeholder = 'Ask about your inbox, jobs, or agents…',
  footerNote = 'Reads space memory · Nothing runs without your approval',
  maxLength = 2000,
  className,
}: CitedAnswerChatInputProps) {
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy || disabled) return;
    onSubmit(trimmed);
  };

  return (
    <form
      data-slot="cited-answer-chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-raised)] p-3 shadow-sm transition-colors focus-within:border-[var(--brand)]',
        className,
      )}
    >
      <label htmlFor="chat-composer-input" className="sr-only">
        Ask about this space
      </label>
      <textarea
        id="chat-composer-input"
        rows={2}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className="block min-h-[52px] w-full resize-none rounded-[var(--radius-sm)] bg-transparent px-1 py-0.5 text-sm leading-6 text-[var(--text)] outline-none placeholder:text-[var(--text-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-subtle)]">
          <BookOpen aria-hidden="true" className="size-3 shrink-0" />
          <span>{footerNote}</span>
        </span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-[var(--text-subtle)]">
            Enter ↵
          </span>
          {busy && onStop ? (
            <button
              type="button"
              aria-label="Stop generating"
              onClick={onStop}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[var(--radius-md)] bg-[var(--danger)] text-[var(--text-inverse)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
            >
              <Square aria-hidden="true" className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send message"
              disabled={disabled || busy || !value.trim()}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-[var(--radius-md)] bg-[var(--brand)] text-[var(--on-brand)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

export default CitedAnswerChatInput;
