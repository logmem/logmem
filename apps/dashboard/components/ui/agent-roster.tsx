'use client';

import * as React from 'react';
import {
  AlertOctagon,
  CheckCircle2,
  CircleSlash,
  Hourglass,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '../../lib/utils';

export type AgentRosterStatus =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'blocked'
  | 'offline';

export interface RosterAgent {
  id: string;
  name: string;
  /** Role or reporting surface, e.g. "Writes the code" or "via claude-code". */
  role?: string;
  status: AgentRosterStatus;
  /** What it is doing right now, or last recap line. */
  task?: string;
  /** Optional real utilization 0–100; omitted when no real load metric exists. */
  load?: number;
  /** Formatted last-active time, e.g. "2m ago". */
  lastActive?: string;
  /** Optional active job badge, e.g. "job:ui-polish". */
  job?: string;
}

const STATUS: Record<
  AgentRosterStatus,
  { icon: LucideIcon; label: string; toneClass: string }
> = {
  working: {
    icon: Loader2,
    label: 'Working',
    toneClass: 'text-[var(--success)]',
  },
  waiting: {
    icon: Hourglass,
    label: 'Waiting',
    toneClass: 'text-[var(--text)]',
  },
  blocked: {
    icon: AlertOctagon,
    label: 'Blocked',
    toneClass: 'text-[var(--danger)]',
  },
  idle: {
    icon: CheckCircle2,
    label: 'Idle',
    toneClass: 'text-[var(--text-muted)]',
  },
  offline: {
    icon: CircleSlash,
    label: 'Offline',
    toneClass: 'text-[var(--text-subtle)]',
  },
};

const ORDER: AgentRosterStatus[] = [
  'working',
  'waiting',
  'blocked',
  'idle',
  'offline',
];

function getInitials(name: string): string {
  return name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export type AgentRosterProps = Omit<
  React.ComponentProps<'section'>,
  'onSelect' | 'title'
> & {
  /** The agents to display. */
  agents: RosterAgent[];
  /** Controlled selected agent id. */
  selected?: string | null;
  /** Uncontrolled initial selected agent id. */
  defaultSelected?: string | null;
  /** Called when an agent card is toggled. */
  onSelectedChange?: (id: string | null) => void;
  /** Section heading. */
  title?: string;
  /** Optional slot rendered on the right of the header bar (e.g. search or view switch). */
  headerSlot?: React.ReactNode;
  /** Optional detail bar rendered below the grid when an agent is selected. */
  renderSelectedBar?: (agent: RosterAgent) => React.ReactNode;
};

/**
 * Ballmac UI Agent Roster adapted to LogMem design tokens:
 * status filter pills + crisp selectable agent cards with optional load meter.
 */
export function AgentRoster({
  agents,
  selected: selectedProp,
  defaultSelected = null,
  onSelectedChange,
  title = 'Agents',
  headerSlot,
  renderSelectedBar,
  className,
  ...props
}: AgentRosterProps) {
  const uid = React.useId();
  const [inner, setInner] = React.useState<string | null>(defaultSelected);
  const selected = selectedProp !== undefined ? selectedProp : inner;
  const [filter, setFilter] = React.useState<AgentRosterStatus | 'all'>('all');

  const count = (s: AgentRosterStatus) =>
    agents.filter((a) => a.status === s).length;
  const shown =
    filter === 'all' ? agents : agents.filter((a) => a.status === filter);
  const selectedAgent = selected
    ? agents.find((a) => a.id === selected) ?? null
    : null;

  function pick(id: string) {
    const next = id === selected ? null : id;
    if (selectedProp === undefined) setInner(next);
    onSelectedChange?.(next);
  }

  return (
    <section
      data-slot="agent-roster"
      aria-labelledby={`${uid}-t`}
      className={cn('grid w-full min-w-0 gap-4', className)}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3
            id={`${uid}-t`}
            className="text-sm font-semibold text-[var(--text)]"
          >
            {title}
          </h3>
          <div
            role="group"
            aria-label="Filter by status"
            className="flex max-w-full flex-wrap gap-1.5"
          >
            {(['all', ...ORDER] as const).map((k) => {
              const n = k === 'all' ? agents.length : count(k);
              if (k !== 'all' && n === 0) return null;
              const active = filter === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(k)}
                  className={cn(
                    'h-8 rounded-[var(--radius-pill)] border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] motion-reduce:transition-none',
                    active
                      ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--on-brand)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]',
                  )}
                >
                  {k === 'all' ? 'All' : STATUS[k].label}{' '}
                  <span
                    className={cn(
                      'tabular-nums',
                      active ? 'opacity-80' : 'text-[var(--text-subtle)]',
                    )}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {headerSlot ? (
          <div className="flex flex-wrap items-center gap-2">{headerSlot}</div>
        ) : null}
      </div>

      <p aria-live="polite" className="sr-only">
        {shown.length} agents shown
      </p>

      {shown.length === 0 ? (
        <p className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          No agents match this filter.
        </p>
      ) : (
        <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
          {shown.map((a) => {
            const s = STATUS[a.status];
            const Icon = s.icon;
            const on = selected === a.id;
            return (
              <li key={a.id} className="min-w-0">
                <button
                  type="button"
                  data-status={a.status}
                  aria-pressed={on}
                  onClick={() => pick(a.id)}
                  className={cn(
                    'flex h-full w-full flex-col gap-3 rounded-[var(--radius-md)] border bg-[var(--surface)] p-4 text-start text-[var(--text)] transition-[border-color,background-color] duration-150 hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] motion-reduce:transition-none',
                    on
                      ? 'border-[var(--brand)] bg-[var(--surface-sunken)]'
                      : a.status === 'blocked'
                        ? 'border-[var(--danger)]'
                        : 'border-[var(--border)]',
                  )}
                >
                  <span className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--border)] bg-[var(--surface-sunken)] font-mono text-xs font-semibold text-[var(--text)]"
                    >
                      {getInitials(a.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--text)]">
                        {a.name}
                      </span>
                      {a.role ? (
                        <span className="block truncate font-mono text-[11px] text-[var(--text-subtle)]">
                          {a.role}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1.5 text-xs font-medium',
                        s.toneClass,
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          'size-3.5',
                          a.status === 'working' && 'motion-safe:animate-spin',
                        )}
                      />
                      {s.label}
                    </span>
                  </span>

                  {a.task ? (
                    <span className="line-clamp-2 text-[13px] leading-snug text-[var(--text-muted)]">
                      {a.task}
                    </span>
                  ) : (
                    <span className="text-[13px] leading-snug text-[var(--text-subtle)]">
                      No active task recorded.
                    </span>
                  )}

                  <span className="mt-auto flex items-center gap-3 pt-1">
                    {typeof a.load === 'number' ? (
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          role="meter"
                          aria-label={`${a.name} load`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(a.load)}
                          className="h-1.5 flex-1 overflow-hidden rounded-[var(--radius-pill)] bg-[var(--surface-sunken)]"
                        >
                          <span
                            className="block h-full rounded-[var(--radius-pill)] bg-[var(--brand)]"
                            style={{
                              width: `${Math.min(100, Math.max(0, a.load))}%`,
                            }}
                          />
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-[var(--text-subtle)]">
                          {Math.round(a.load)}%
                        </span>
                      </span>
                    ) : a.job ? (
                      <span className="max-w-[11rem] truncate rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                        {a.job}
                      </span>
                    ) : null}
                    {a.lastActive ? (
                      <span className="ms-auto font-mono text-[11px] tabular-nums text-[var(--text-subtle)]">
                        {a.lastActive}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedAgent && renderSelectedBar ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--surface-sunken)] px-4 py-3">
          {renderSelectedBar(selectedAgent)}
        </div>
      ) : null}
    </section>
  );
}

export default AgentRoster;
