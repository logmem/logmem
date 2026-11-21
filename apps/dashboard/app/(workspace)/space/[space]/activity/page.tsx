import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  return <SpacePage title="Activity" body="No activity is recorded in this space yet." />;
}
