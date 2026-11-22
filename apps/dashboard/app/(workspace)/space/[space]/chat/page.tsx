import { requireSpace } from '../../../../../lib/server/auth';
import { PageHeader } from '../../../../../components/ui';
import { ChatPanel } from '../components/chat-panel';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  return (
    <div className="space-y-4 font-sans">
      <PageHeader
        title="Chat"
        subtitle="Read only. Answers come from this space. Nothing runs without your approval."
      />
      <ChatPanel space={space} />
    </div>
  );
}
