import { requireSpace } from '../../../../../lib/server/auth';
import { getAgentsData } from '../../../../../lib/server/agents';
import { agentCounts } from '../../../../../lib/agents-model.mjs';
import { PageHeader, StatTile, StatePanel } from '../../../../../components/ui';
import { AgentsTableView } from '../components/agents-table-view';

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

      <AgentsTableView space={space} agents={agents} now={now} />
    </div>
  );
}
