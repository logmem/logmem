'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRight, LayoutGrid, Search, Table2 } from 'lucide-react';
import {
  AgentRoster,
  CopyId,
  StatePanel,
  type AgentRosterStatus,
  type RosterAgent,
} from '../../../../../components/ui';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { AgentRow } from '../../../../../lib/server/agents';

interface AgentsTableViewProps {
  space: string;
  agents: AgentRow[];
  now: number;
}

type StatusFilter = 'all' | 'active' | 'quiet' | 'no-now';
type ViewMode = 'cards' | 'table';

function toRosterStatus(a: AgentRow): AgentRosterStatus {
  if (a.blocked) return 'blocked';
  if (a.state === 'active') return a.doing ? 'working' : 'waiting';
  if (a.state === 'idle') return 'idle';
  return 'offline';
}

export function AgentsTableView({ space, agents, now }: AgentsTableViewProps) {
  const [view, setView] = React.useState<ViewMode>('cards');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<StatusFilter>('all');
  const [selectedId, setSelectedId] = React.useState<string | null>(
    agents[0]?.id ?? null,
  );

  const counts = React.useMemo(
    () => ({
      all: agents.length,
      active: agents.filter((a) => a.state === 'active').length,
      quiet: agents.filter((a) => a.state !== 'active').length,
      'no-now': agents.filter((a) => !a.doing).length,
    }),
    [agents],
  );

  const queried = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) =>
      [a.id, a.name, a.role, a.doing, a.recapSummary, a.surface]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [agents, query]);

  const visibleTable = React.useMemo(
    () =>
      queried.filter((a) => {
        if (filter === 'active' && a.state !== 'active') return false;
        if (filter === 'quiet' && a.state === 'active') return false;
        if (filter === 'no-now' && a.doing) return false;
        return true;
      }),
    [queried, filter],
  );

  const rosterAgents = React.useMemo<RosterAgent[]>(
    () =>
      queried.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.surface ? `via ${a.surface}` : a.role || `agent:${a.id}`,
        status: toRosterStatus(a),
        task: a.doing || a.recapSummary || undefined,
        job: a.job || undefined,
        lastActive: a.lastTs ? relativeTime(a.lastTs, now) : undefined,
      })),
    [queried, now],
  );

  if (agents.length === 0) {
    return (
      <StatePanel
        variant="empty"
        title="No agents have written to this space yet."
        detail="Connect an agent and call logmem_start to register its shift here."
      />
    );
  }

  const viewToggle = (
    <div
      role="group"
      aria-label="Roster layout"
      className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-0.5"
    >
      <button
        type="button"
        aria-pressed={view === 'cards'}
        onClick={() => setView('cards')}
        className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
          view === 'cards'
            ? 'bg-[var(--brand)] text-[var(--on-brand)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text)]'
        }`}
      >
        <LayoutGrid aria-hidden="true" className="size-3.5" />
        Roster
      </button>
      <button
        type="button"
        aria-pressed={view === 'table'}
        onClick={() => setView('table')}
        className={`inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
          view === 'table'
            ? 'bg-[var(--brand)] text-[var(--on-brand)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text)]'
        }`}
      >
        <Table2 aria-hidden="true" className="size-3.5" />
        Table
      </button>
    </div>
  );

  const searchInput = (
    <div className="relative w-full sm:w-60">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-subtle)]"
      />
      <label htmlFor="next-agents-search" className="sr-only">
        Search agents
      </label>
      <input
        id="next-agents-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search agents…"
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-8 pr-3 text-xs text-[var(--text)] placeholder:text-[var(--text-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      />
    </div>
  );

  if (view === 'cards') {
    return (
      <AgentRoster
        title="Fleet roster"
        agents={rosterAgents}
        selected={selectedId}
        onSelectedChange={setSelectedId}
        headerSlot={
          <>
            {searchInput}
            {viewToggle}
          </>
        }
        renderSelectedBar={(sel) => {
          const raw = agents.find((x) => x.id === sel.id);
          return (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text)]">
                  {sel.name}{' '}
                  <span className="font-mono text-xs font-normal text-[var(--text-subtle)]">
                    {sel.role}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  {raw?.doing ||
                    raw?.recapSummary ||
                    'No active task or recap recorded yet.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <CopyId id={`agent:${sel.id}`} label={`Copy agent:${sel.id}`} />
                <Link
                  href={`/space/${encodeURIComponent(space)}/agents/${encodeURIComponent(sel.id)}`}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--brand)] px-3 py-1.5 text-xs font-medium text-[var(--on-brand)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                >
                  Inspect agent
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
            </div>
          );
        }}
      />
    );
  }

  return (
    <section
      aria-label="Agent roster"
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
        <div
          role="group"
          aria-label="Filter agents"
          className="flex flex-wrap items-center gap-1.5"
        >
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['quiet', 'Quiet'],
              ['no-now', 'No Now'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
                filter === id
                  ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--on-brand)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
              }`}
            >
              {label} ({counts[id]})
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {searchInput}
          {viewToggle}
        </div>
      </div>

      {visibleTable.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
          No agents match this filter.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface)] font-mono text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                <th className="px-4 py-2.5 font-semibold">Agent</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Current work</th>
                <th className="px-4 py-2.5 font-semibold">Last recap</th>
                <th className="px-4 py-2.5 font-semibold">Updated</th>
                <th className="px-4 py-2.5 text-right font-semibold">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visibleTable.map((a) => (
                <tr
                  key={a.id}
                  className="transition-colors hover:bg-[var(--surface-sunken)]"
                >
                  <td className="px-4 py-3 align-middle">
                    <div className="flex items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] font-mono text-[11px] font-semibold uppercase text-[var(--text)]"
                      >
                        {a.name.slice(0, 2)}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={`/space/${encodeURIComponent(space)}/agents/${encodeURIComponent(a.id)}`}
                          className="block truncate font-semibold text-[var(--text)] hover:text-[var(--link)] hover:underline"
                        >
                          {a.name}
                        </Link>
                        <span className="block truncate font-mono text-[11px] text-[var(--text-subtle)]">
                          {a.surface
                            ? `via ${a.surface}`
                            : a.role || `agent:${a.id}`}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <span
                      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] px-2 py-0.5 font-mono text-[11px] font-medium ${
                        a.blocked
                          ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                          : a.state === 'active'
                            ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                            : 'border border-[var(--border)] bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-current"
                      />
                      {a.blocked ? 'Blocked' : a.statusLabel}
                    </span>
                  </td>
                  <td className="max-w-xs px-4 py-3 align-middle text-xs">
                    {a.doing ? (
                      <span className="line-clamp-2 text-[var(--text)]">
                        {a.doing}
                      </span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">
                        No active task
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 align-middle text-xs text-[var(--text-muted)]">
                    {a.recapSummary ? (
                      <span className="line-clamp-2">{a.recapSummary}</span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">
                        No recap yet
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 align-middle font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                    {a.lastTs ? relativeTime(a.lastTs, now) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right align-middle">
                    <div className="inline-flex items-center gap-1.5">
                      <Link
                        href={`/space/${encodeURIComponent(space)}/agents/${encodeURIComponent(a.id)}`}
                        className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text)] hover:border-[var(--border-strong)] hover:text-[var(--link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                      >
                        Open
                      </Link>
                      <CopyId
                        id={`agent:${a.id}`}
                        label={`Copy agent:${a.id}`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
