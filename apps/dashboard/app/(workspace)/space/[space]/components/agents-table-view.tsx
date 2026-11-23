'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { CopyId, StatePanel } from '../../../../../components/ui';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { AgentRow } from '../../../../../lib/server/agents';

interface AgentsTableViewProps {
  space: string;
  agents: AgentRow[];
  now: number;
}

type StatusFilter = 'all' | 'active' | 'quiet' | 'no-now';

export function AgentsTableView({ space, agents, now }: AgentsTableViewProps) {
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<StatusFilter>('all');

  const counts = React.useMemo(
    () => ({
      all: agents.length,
      active: agents.filter((a) => a.state === 'active').length,
      quiet: agents.filter((a) => a.state !== 'active').length,
      'no-now': agents.filter((a) => !a.doing).length,
    }),
    [agents],
  );

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter === 'active' && a.state !== 'active') return false;
      if (filter === 'quiet' && a.state === 'active') return false;
      if (filter === 'no-now' && a.doing) return false;
      if (!q) return true;
      return [a.id, a.name, a.role, a.doing, a.recapSummary, a.surface]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [agents, filter, query]);

  if (agents.length === 0) {
    return (
      <StatePanel
        variant="empty"
        title="No agents have written to this space yet."
        detail="Connect an agent and call logmem_start to register its shift here."
      />
    );
  }

  return (
    <section
      aria-label="Agent roster"
      className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
        <div role="group" aria-label="Filter agents" className="flex flex-wrap items-center gap-1.5">
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

        <div className="relative w-full sm:w-64">
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
      </div>

      {visible.length === 0 ? (
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
                <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {visible.map((a) => (
                <tr key={a.id} className="transition-colors hover:bg-[var(--surface-sunken)]">
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
                          {a.surface ? `via ${a.surface}` : a.role || `agent:${a.id}`}
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
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                      {a.blocked ? 'Blocked' : a.statusLabel}
                    </span>
                  </td>
                  <td className="max-w-xs px-4 py-3 align-middle text-xs">
                    {a.doing ? (
                      <span className="line-clamp-2 text-[var(--text)]">{a.doing}</span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">No active task</span>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-3 align-middle text-xs text-[var(--text-muted)]">
                    {a.recapSummary ? (
                      <span className="line-clamp-2">{a.recapSummary}</span>
                    ) : (
                      <span className="text-[var(--text-subtle)]">No recap yet</span>
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
                      <CopyId id={`agent:${a.id}`} label={`Copy agent:${a.id}`} />
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
