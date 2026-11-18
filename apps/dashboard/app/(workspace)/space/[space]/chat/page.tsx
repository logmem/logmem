import { requireSpace } from '../../../../../lib/server/auth';
import { ChatPanel } from '../components/chat-panel';

export const dynamic = 'force-dynamic';

export default async function ChatPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  return (
    <div className="space-y-4 font-sans">
      <div className="border-b border-[#D3DAD8] pb-4 dark:border-[#2B3835]">
        <h1 className="font-['Schibsted_Grotesk'] text-2xl font-bold md:text-3xl">Chat</h1>
        <p className="mt-1 text-sm text-[#46534F] dark:text-[#B3BEBA]">Read only. Answers come from this space. Nothing runs without your approval.</p>
      </div>
      <ChatPanel space={space} />
    </div>
  );
}
