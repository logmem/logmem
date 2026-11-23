import Link from 'next/link';
import { requireSpace } from '../../../../../../lib/server/auth';
import { getAgentDetailData } from '../../../../../../lib/server/agent-detail';
import { PageHeader, StatePanel } from '../../../../../../components/ui';
import { AgentDetailView } from '../../components/agent-detail-view';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ space: string; agent: string }>;
}) {
  const { space, agent: rawAgent } = await params;
  await requireSpace(space, 'read');
  const { agent, invalid, unavailable, now } = await getAgentDetailData(space, rawAgent);

  if (invalid) {
    return (
      <div className="space-y-6 font-sans">
        <PageHeader title="Agent" subtitle={`space:${space}`} />
        <StatePanel
          variant="empty"
          title="That agent identifier is not valid."
          detail="Return to the Agents directory to pick a registered agent in this space."
        />
        <Link
          href={`/space/${encodeURIComponent(space)}/agents`}
          className="inline-block text-sm font-medium text-[var(--link)] hover:underline"
        >
          ← Back to Agents
        </Link>
      </div>
    );
  }

  if (unavailable || !agent) {
    return (
      <div className="space-y-6 font-sans">
        <PageHeader title="Agent" subtitle={`space:${space}`} />
        <StatePanel
          variant="error"
          title="Agent details could not be read right now."
          detail="Nothing is shown because an empty profile would be wrong. Reload to try again."
        />
      </div>
    );
  }

  return <AgentDetailView space={space} agent={agent} now={now} />;
}
