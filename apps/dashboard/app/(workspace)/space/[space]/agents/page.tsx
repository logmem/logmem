import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function AgentsPage({ params }: { params: { space: string } }) {
  await requireSpace(params.space, 'read');
  return <SpacePage title="Agents" body="No agents are in this space yet." />;
}
