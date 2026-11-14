import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function WorkPage({ params }: { params: { space: string } }) {
  await requireSpace(params.space, 'read');
  return <SpacePage title="Work" body="No jobs are open in this space yet." />;
}
