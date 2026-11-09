import { requireSpace } from '../../../../../lib/server/auth';
import { SpacePage } from '../components/space-page';

export const dynamic = 'force-dynamic';

export default async function TodayPage({ params }: { params: { space: string } }) {
  await requireSpace(params.space, 'read');
  return <SpacePage title="Today" body="Nothing in this space needs a decision yet." />;
}
