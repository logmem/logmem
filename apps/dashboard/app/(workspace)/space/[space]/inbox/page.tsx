import { requireSpace } from '../../../../../lib/server/auth';
import { getInboxData } from '../../../../../lib/server/inbox';
import { InboxView } from '../components/inbox-view';

export const dynamic = 'force-dynamic';

export default async function InboxPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  // Cached per request: getInboxData reuses this check.
  await requireSpace(space, 'read');
  const data = await getInboxData(space);
  return <InboxView space={space} {...data} />;
}
