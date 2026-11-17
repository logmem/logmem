import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function SchedulePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  return <SpacePage title="Schedule" body="No shifts are scheduled in this space yet." />;
}
