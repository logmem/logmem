'use client';

// Adapted from 21st.dev component 29425 (coss.com — Tabs with Count Badge),
// restyled strictly to LogMem semantic var(--*) tokens (zero raw hex).
import * as React from 'react';

export interface InboxSectionTabItem {
  id: string;
  label: string;
  count: number;
  tone?: 'neutral' | 'decision' | 'brand' | 'warning' | 'success';
}

export interface InboxSectionTabsProps {
  tabs: InboxSectionTabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  ariaLabel?: string;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

function badgeToneClass(tone: InboxSectionTabItem['tone'], count: number): string {
  if (count === 0) {
    return 'border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-subtle)]';
  }
  switch (tone) {
    case 'decision':
      return 'border-[var(--decision)] bg-[var(--decision-subtle)] text-[var(--decision)]';
    case 'brand':
      return 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]';
    case 'warning':
      return 'border-[var(--warning)] bg-[var(--warning-subtle)] text-[var(--warning)]';
    case 'success':
      return 'border-[var(--success)] bg-[var(--success-subtle)] text-[var(--success)]';
    default:
      return 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]';
  }
}

export function InboxSectionTabs({
  tabs,
  activeId,
  onSelect,
  ariaLabel = 'Inbox sections',
}: InboxSectionTabsProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className="sticky top-0 z-20 -mx-1 flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg)] px-1 py-1.5"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={() => onSelect(tab.id)}
            className={`inline-flex min-h-[38px] shrink-0 items-center gap-2 rounded-t-[var(--radius-sm)] border-b-2 px-3 py-1.5 text-sm transition-colors motion-reduce:transition-none ${FOCUS} ${
              active
                ? 'border-[var(--brand)] font-semibold text-[var(--brand)]'
                : 'border-transparent font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]'
            }`}
          >
            <span>{tab.label}</span>
            <span
              className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded-full border px-1.5 font-mono text-[11px] font-semibold tabular-nums ${badgeToneClass(tab.tone, tab.count)}`}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
