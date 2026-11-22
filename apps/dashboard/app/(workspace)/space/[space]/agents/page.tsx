import { requireSpace } from '../../../../../lib/server/auth';
import { getAgentsData } from '../../../../../lib/server/agents';
import { agentCounts } from '../../../../../lib/agents-model.mjs';
import { relativeTime } from '../../../../../lib/inbox-model.mjs';
import { CopyId, PageHeader, StatTile, StatePanel } from '../../../../../components/ui';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const { agents, unavailable, now } = await getAgentsData(space);

  if (unavailable) {
    return (
      <div className="space-y-6 font-sans">
        <PageHeader title="Agents" subtitle={`space:${space}`} />
        <StatePanel
          variant="error"
          title="Agents could not be read right now."
          detail="Nothing is shown because an empty roster would be wrong. Reload to try again."
        />
      </div>
    );
  }

  const counts = agentCounts(agents);

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Agents"
        subtitle={`Reporting status in space:${space} · reporting activity, not runtime reachability.`}
      />

      <section aria-label="Agent counts" className="lm-stat-grid">
        <StatTile label="Total" value={counts.total} note="in this space" />
        <StatTile label="Active" value={counts.active} note="wrote recently" />
        <StatTile label="Idle" value={counts.idle} note="recent shift" />
        <StatTile label="Quiet" value={counts.quiet} note="no recent write" />
      </section>

      {agents.length === 0 ? (
        <StatePanel
          variant="empty"
          title="No agents have written to this space yet."
          detail="Connect an agent and call logmem_start to register its shift here."
        />
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]">
          {agents.map((a) => (
            <li key={a.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text)]">{a.name}</span>
                  <span
                    className={`rounded-[var(--radius-pill)] px-2 py-0.5 font-mono text-[11px] font-medium ${
                      a.state === 'active'
                        ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                        : a.blocked
                          ? 'bg-[var(--danger-subtle)] text-[var(--danger)]'
                          : 'bg-[var(--surface-sunken)] text-[var(--text-muted)]'
                    }`}
                  >
                    {a.statusLabel}
                  </span>
                  {a.surface ? (
                    <span className="font-mono text-xs text-[var(--text-subtle)]">via {a.surface}</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {a.lastTs ? (
                    <span className="font-mono text-xs tabular-nums text-[var(--text-subtle)]">
                      {relativeTime(a.lastTs, now)}
                    </span>
                  ) : null}
                  <CopyId id={`agent:${a.id}`} label={`Copy agent:${a.id}`} />
                </div>
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                {a.doing || 'No current task recorded.'}
              </p>
              {a.recapSummary ? (
                <p className="line-clamp-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-sunken)] px-2.5 py-1.5 text-xs text-[var(--text-muted)]">
                  <span className="font-semibold text-[var(--text)]">
                    Last recap{a.recapMode ? ` (${a.recapMode})` : ''}:{' '}
                  </span>
                  {a.recapSummary}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
