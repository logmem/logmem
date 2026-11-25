'use client';

// Adapted from 21st.dev Heat Map XL (Reaviz pattern) with LobeHub agent icons,
// zero external chart deps, and strict LogMem var(--*) semantic tokens (zero raw hex).
import * as React from 'react';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Clock } from 'lucide-react';

export interface HeatMapCell {
  from: string;
  to: string;
  count: number;
  band: 'fresh' | 'slow' | 'stale';
  label: string;
}

export interface HeatMapXLProps {
  agents: string[];
  cells: Record<string, HeatMapCell>;
  totalOpen: number;
  delayedCount: number;
  oldestLabel: string;
  selectedPair?: { from: string; to: string } | null;
  onSelectPair?: (pair: { from: string; to: string } | null) => void;
}

const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';

const LOBE_ALIASES: Record<string, string> = {
  'claude-code': 'claudecode',
  'gemini-cli': 'geminicli',
  hermes: 'hermesagent',
  'grok-local': 'grok',
  atlas: 'atlascloud',
  relay: 'relace',
  quill: 'lobehub',
  tally: 'tavily',
  polar: 'pollinations',
  mikey: 'openhuman',
  admin: 'openhuman',
};

const LOBE_POOL = [
  'anthropic',
  'openai',
  'gemini',
  'grok',
  'deepseek',
  'mistral',
  'perplexity',
  'cohere',
  'cursor',
  'vercel',
];

export function resolveLobeIconSrc(name: string): string {
  const bare = String(name || '')
    .replace(/^(agent|human|person):/i, '')
    .toLowerCase()
    .trim();
  const slug = LOBE_ALIASES[bare];
  if (slug) return `/icons/lobehub/${slug}.svg`;
  if (/^[a-z0-9]+$/.test(bare) && ['claude', 'codex', 'gemini', 'grok', 'muse', 'cursor', 'opencode', 'antigravity'].includes(bare)) {
    return `/icons/lobehub/${bare}.svg`;
  }
  let hash = 0;
  for (let i = 0; i < bare.length; i++) hash = (hash * 31 + bare.charCodeAt(i)) >>> 0;
  return `/icons/lobehub/${LOBE_POOL[hash % LOBE_POOL.length]}.svg`;
}

function AgentHeaderChip({ name }: { name: string }) {
  const [failed, setFailed] = React.useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {!failed ? (
        <img
          src={resolveLobeIconSrc(name)}
          alt=""
          className="h-[18px] w-[18px] shrink-0 rounded-[5px] border border-[var(--border)] bg-[var(--surface-raised)] p-0.5 object-contain dark:bg-[var(--text)]"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] bg-[var(--surface-sunken)] font-mono text-[9px] font-semibold uppercase text-[var(--text-muted)]">
          {name.slice(0, 2)}
        </span>
      )}
      <span>{name}</span>
    </span>
  );
}

export function HeatMapXL({
  agents,
  cells,
  totalOpen,
  delayedCount,
  oldestLabel,
  selectedPair = null,
  onSelectPair,
}: HeatMapXLProps) {
  const [filterMode, setFilterMode] = React.useState<'all' | 'late'>('all');

  const visibleCells = React.useMemo(() => {
    const entries = Object.values(cells);
    const filtered = filterMode === 'late' ? entries.filter((c) => c.band !== 'fresh') : entries;
    const map: Record<string, HeatMapCell> = {};
    for (const c of filtered) map[`${c.from}>${c.to}`] = c;
    return map;
  }, [cells, filterMode]);

  const cellValues = Object.values(visibleCells);
  const maxCount = Math.max(1, ...cellValues.map((c) => c.count));
  const delayedPct = totalOpen > 0 ? Math.round((delayedCount / totalOpen) * 100) : 0;
  const busiest = [...cellValues].sort((a, b) => b.count - a.count)[0] ?? null;

  const cellClasses = (cell: HeatMapCell) => {
    if (cell.band === 'stale') {
      return 'border-[var(--danger)] bg-[var(--danger-subtle)] text-[var(--danger)]';
    }
    if (cell.band === 'slow') {
      return 'border-[var(--warning)] bg-[var(--warning-subtle)] text-[var(--warning)]';
    }
    return 'border-[var(--brand)] bg-[var(--brand-subtle)] text-[var(--brand)]';
  };

  return (
    <div className="space-y-4 rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)] shadow-[var(--shadow-1)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-heading text-lg font-bold tracking-tight text-[var(--text)]">
            Handoff Matrix
          </h3>
          <p className="text-xs text-[var(--text-muted)]">
            Rows send, columns receive. Select a cell to filter.
          </p>
        </div>
        <select
          aria-label="Filter handoff matrix urgency"
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value as 'all' | 'late')}
          className={`min-h-[34px] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 text-xs font-medium text-[var(--text)] ${FOCUS}`}
        >
          <option value="all">All open ({totalOpen})</option>
          <option value="late">Over 24h ({delayedCount})</option>
        </select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_32px]">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-1.5">
            <caption className="sr-only">Open handoffs by sender and receiver</caption>
            <thead>
              <tr>
                <th className="px-1.5 py-1 text-left font-mono text-[11px] font-medium text-[var(--text-subtle)]">
                  From \ To
                </th>
                {agents.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className="px-1.5 py-1 text-center text-xs font-medium text-[var(--text-muted)]"
                  >
                    <AgentHeaderChip name={name} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((row) => (
                <tr key={row}>
                  <th
                    scope="row"
                    className="px-1.5 py-1 text-left text-xs font-medium text-[var(--text-muted)]"
                  >
                    <AgentHeaderChip name={row} />
                  </th>
                  {agents.map((col) => {
                    const cell = visibleCells[`${row}>${col}`];
                    const isSelected = selectedPair?.from === row && selectedPair?.to === col;
                    if (!cell) {
                      return (
                        <td key={col}>
                          <span
                            aria-hidden="true"
                            className="grid min-h-[46px] min-w-[54px] place-items-center rounded-[10px] bg-[var(--surface-sunken)] text-xs text-[var(--text-subtle)]"
                          >
                            {row === col ? '·' : ''}
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={col}>
                        <button
                          type="button"
                          aria-pressed={isSelected}
                          title={`${row} → ${col}: ${cell.count} open · oldest ${cell.label}`}
                          onClick={() =>
                            onSelectPair?.(isSelected ? null : { from: row, to: col })
                          }
                          className={`grid min-h-[46px] w-full min-w-[54px] place-items-center rounded-[10px] border px-2 py-1 font-mono transition-transform hover:-translate-y-0.5 motion-reduce:transition-none ${FOCUS} ${cellClasses(cell)} ${
                            isSelected ? 'ring-2 ring-[var(--focus)]' : ''
                          }`}
                        >
                          <strong className="text-sm font-bold leading-none tabular-nums">
                            {cell.count}
                          </strong>
                          <span className="text-[10px] leading-none opacity-85">{cell.label}</span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Sequential Legend */}
        <aside
          aria-label="Heat intensity scale"
          className="flex flex-row items-center justify-center gap-2 sm:flex-col"
        >
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">
            {maxCount}
          </span>
          <span
            aria-hidden="true"
            className="h-3 flex-1 rounded-full border border-[var(--border)] bg-gradient-to-r from-[var(--brand-subtle)] via-[var(--warning)] to-[var(--danger)] sm:h-auto sm:w-3.5 sm:max-h-[150px] sm:bg-gradient-to-t"
          />
          <span className="font-mono text-[11px] text-[var(--text-subtle)] tabular-nums">0</span>
        </aside>
      </div>

      {/* 2-Column Summary Stats */}
      <div className="grid grid-cols-1 gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-2">
        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Delayed Handoffs</span>
          <div className="flex items-center gap-2">
            <strong className="font-mono text-2xl font-bold tabular-nums text-[var(--text)]">
              {delayedCount}
            </strong>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs font-semibold ${
                delayedCount > 0
                  ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                  : 'bg-[var(--success-subtle)] text-[var(--success)]'
              }`}
            >
              {delayedCount > 0 ? (
                <ArrowUp className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ArrowDown className="h-3 w-3" aria-hidden="true" />
              )}
              {delayedPct}%
            </span>
          </div>
          <p className="text-xs text-[var(--text-subtle)]">Open longer than 24 hours</p>
        </div>

        <div className="space-y-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Total Open Handoffs</span>
          <div className="flex items-center gap-2">
            <strong className="font-mono text-2xl font-bold tabular-nums text-[var(--text)]">
              {totalOpen}
            </strong>
            <span className="inline-flex items-center rounded-full bg-[var(--brand-subtle)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--brand)]">
              {agents.length} agents
            </span>
          </div>
          <p className="text-xs text-[var(--text-subtle)]">
            Active across {cellValues.length} sender→receiver pairs
          </p>
        </div>
      </div>

      {/* 3-Row Metrics Breakdown */}
      <div className="divide-y divide-[var(--border)] border-t border-[var(--border)] font-mono text-xs">
        <div className="flex items-center justify-between gap-2 py-2.5">
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <Clock className="h-4 w-4 text-[var(--danger)]" aria-hidden="true" />
            Oldest Unanswered Wait
          </span>
          <strong className="text-sm font-semibold text-[var(--text)]">{oldestLabel}</strong>
        </div>
        <div className="flex items-center justify-between gap-2 py-2.5">
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <ArrowRight className="h-4 w-4 text-[var(--brand)]" aria-hidden="true" />
            Busiest Route
          </span>
          <strong className="text-sm font-semibold text-[var(--text)]">
            {busiest ? `${busiest.from} → ${busiest.to} (${busiest.count})` : 'None'}
          </strong>
        </div>
        <div className="flex items-center justify-between gap-2 py-2.5">
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <AlertTriangle className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" />
            Active Agent Pairs
          </span>
          <strong className="text-sm font-semibold text-[var(--text)]">{cellValues.length}</strong>
        </div>
      </div>
    </div>
  );
}
