import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function AccessPage({ params }: { params: { space: string } }) {
  await requireSpace(params.space, 'read');
  return <SpacePage title="Agent access" body="No agent keys or connected apps are in this space yet." />;
}
