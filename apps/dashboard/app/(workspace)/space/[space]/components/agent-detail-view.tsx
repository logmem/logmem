'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import {
  AgentStatus,
  AgentTrace,
  CopyId,
  EntryRow,
  KindChip,
  PageHeader,
  StatTile,
  StatePanel,
  type TraceSpan,
} from '../../../../../components/ui';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import type { AgentDetailModel, AgentDetailSpan } from '../../../../../lib/server/agent-detail';

interface AgentDetailViewProps {
  space: string;
  agent: AgentDetailModel;
  now: number;
}

export function AgentDetailView({ space, agent, now }: AgentDetailViewProps) {
  const [selectedSpan, setSelectedSpan] = React.useState<AgentDetailSpan | null>(null);
  const [logFilter, setLogFilter] = React.useState<'all' | 'handoffs' | 'problems'>('all');

  const filteredLog = React.useMemo(() => {
    if (logFilter === 'handoffs') {
      return agent.log.filter((e) => e.kind === 'handoff' || e.kind === 'accepted' || e.kind === 'approval');
    }
    if (logFilter === 'problems') {
      return agent.log.filter((e) => e.kind === 'stuck' || e.kind === 'problem' || e.kind === 'alert');
    }
    return agent.log;
  }, [agent.log, logFilter]);

  const handleSelectSpan = React.useCallback(
    (span: TraceSpan) => {
      const full = agent.trace.spans.find((s) => s.id === span.id) ?? (span as AgentDetailSpan);
      setSelectedSpan(full);
    },
    [agent.trace.spans],
  );

  return (
    <div className="space-y-6 font-sans">
      <div className="space-y-2">
        <Link
          href={`/space/${encodeURIComponent(space)}/agents`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--link)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Back to Agents
        </Link>
        <PageHeader
          title={agent.name}
          subtitle={
            agent.role ||
            `agent:${agent.id} in space:${space} · reporting activity, not runtime reachability.`
          }
          actions={<CopyId id={`agent:${agent.id}`} label={`Copy agent:${agent.id}`} />}
        />
      </div>

      <section aria-label="Agent summary metrics" className="lm-stat-grid">
        <StatTile label="Status" value={agent.statusLabel} note={agent.surface ? `via ${agent.surface}` : 'reporting status'} />
        <StatTile label="Open handoffs" value={agent.handoffs.length} note="waiting for reply" />
        <StatTile label="Owned jobs" value={agent.ownedJobs.length} note="in this space" />
        <StatTile label="Recent shifts" value={agent.shifts.length} note="recorded sessions" />
      </section>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <AgentStatus
            title={agent.doing || 'No active task recorded'}
            detail={
              agent.next
                ? `Next: ${agent.next}`
                : agent.job
                  ? `Active job: ${agent.job}`
                  : 'Waiting for next shift or assignment.'
            }
            badge={agent.blocked ? 'Blocked' : agent.statusLabel}
            tasks={agent.statusTasks}
          />
        </div>

        <div className="space-y-3 lg:col-span-7">
          {agent.trace.spans.length > 0 ? (
            <>
              <AgentTrace
                spans={agent.trace.spans}
                duration={agent.trace.duration}
                runId={agent.trace.runId}
                model={agent.trace.model ?? undefined}
                autoPlay={false}
                showTokens={false}
                onSpanSelect={handleSelectSpan}
              />
              {selectedSpan ? (
                <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedSpan.entryKind ? <KindChip kind={selectedSpan.entryKind} /> : null}
                      <span className="font-mono font-semibold text-[var(--text)]">{selectedSpan.label}</span>
                      {selectedSpan.ts ? (
                        <span className="font-mono text-[var(--text-subtle)]">
                          {relativeTime(selectedSpan.ts, now)}
                        </span>
                      ) : null}
                    </div>
                    {selectedSpan.trail ? <CopyId id={selectedSpan.trail} label="Copy trail" /> : null}
                  </div>
                  {selectedSpan.summary ? (
                    <p className="mt-1.5 leading-relaxed text-[var(--text-muted)]">{selectedSpan.summary}</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <StatePanel
              variant="empty"
              title="No shift trace entries yet."
              detail="When this agent records shift entries in LogMem, its scrubbable run trace appears here."
            />
          )}
        </div>
      </div>

      {agent.recap?.summary ? (
        <section
          aria-labelledby="agent-recap-h"
          className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="agent-recap-h" className="font-heading text-sm font-semibold text-[var(--text)]">
              Last recap{agent.recap.mode ? ` (${agent.recap.mode})` : ''}
            </h2>
            {agent.recap.endedAt ? (
              <span className="font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                {relativeTime(agent.recap.endedAt, now)}
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-[var(--text-muted)]">{agent.recap.summary}</p>
          {agent.recap.next.length > 0 ? (
            <ul className="mt-2.5 list-disc space-y-1 pl-5 text-xs text-[var(--text-muted)]">
              {agent.recap.next.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {agent.handoffs.length > 0 ? (
        <section aria-labelledby="agent-handoffs-h" className="space-y-2">
          <h2 id="agent-handoffs-h" className="font-heading text-base font-semibold text-[var(--text)]">
            Open handoffs ({agent.handoffs.length})
          </h2>
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
            {agent.handoffs.map((h) => (
              <li key={h.id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <KindChip kind="handoff" />
                    <span className="font-mono text-xs text-[var(--text-subtle)]">from {h.by}</span>
                    {h.where ? <span className="font-mono text-xs text-[var(--text-subtle)]">· {h.where}</span> : null}
                  </div>
                  <span className="font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                    {h.ts ? relativeTime(h.ts, now) : ''}
                  </span>
                </div>
                <p className="text-sm text-[var(--text)]">{h.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {agent.follows.length > 0 || agent.skills.length > 0 ? (
        <section aria-label="Profile context" className="grid gap-4 md:grid-cols-2">
          {agent.follows.length > 0 ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="font-heading text-sm font-semibold text-[var(--text)]">
                Follows ({agent.follows.length})
              </h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {agent.follows.map((ref) => (
                  <span
                    key={ref}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-muted)]"
                  >
                    {ref}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {agent.skills.length > 0 ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <h2 className="font-heading text-sm font-semibold text-[var(--text)]">Capabilities</h2>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {agent.skills.map((skill) => (
                  <li
                    key={skill}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
                  >
                    {skill}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="agent-log-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="agent-log-h" className="font-heading text-base font-semibold text-[var(--text)]">
            Recent entries ({filteredLog.length})
          </h2>
          <div role="group" aria-label="Filter agent entries" className="flex flex-wrap gap-1.5">
            {(
              [
                ['all', 'All'],
                ['handoffs', 'Handoffs & asks'],
                ['problems', 'Stuck & alerts'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={logFilter === key}
                onClick={() => setLogFilter(key)}
                className={`rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${
                  logFilter === key
                    ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--on-brand)]'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredLog.length === 0 ? (
          <StatePanel
            variant="empty"
            title="No entries match this filter."
            detail="Switch back to All to see every recorded entry on this agent's log."
          />
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-4">
            {filteredLog.map((e) => (
              <EntryRow
                key={e.id}
                kind={e.kind}
                actor={agent.id}
                summary={e.summary}
                where={e.where ?? undefined}
                via={e.via ?? undefined}
                trail={e.id}
                timeLabel={e.ts ? relativeTime(e.ts, now) : '—'}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
