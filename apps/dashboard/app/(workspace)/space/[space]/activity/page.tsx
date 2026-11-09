import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ params }: { params: { space: string } }) {
  await requireSpace(params.space, 'read');
  return <SpacePage title="Activity" body="No activity is recorded in this space yet." />;
}
