import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function WorkPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  return <SpacePage title="Work" body="No jobs are open in this space yet." />;
}
