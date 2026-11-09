import { requireSpace } from '../../../../../lib/server/auth';
import { getInboxData } from '../../../../../lib/server/inbox';
import { InboxView } from '../components/inbox-view';

export const dynamic = 'force-dynamic';

export default async function InboxPage({ params }: { params: { space: string } }) {
  // Cached per request: getInboxData reuses this check.
  await requireSpace(params.space, 'read');
  const data = await getInboxData(params.space);
  return <InboxView space={params.space} {...data} />;
}
