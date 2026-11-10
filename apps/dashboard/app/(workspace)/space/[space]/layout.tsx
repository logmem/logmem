import { NavRail } from './components/nav-rail';
import { requireSpace } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function WorkspaceSpaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { space: string };
}) {
  const viewer = await requireSpace(params.space, 'read');
  const spaceName = viewer.space?.name || params.space;
  return (
    <div className="flex min-h-screen bg-[#F4F6F5] dark:bg-[#0C1211] text-[#121A19] dark:text-[#E9EEEC] font-sans antialiased">
      <NavRail space={params.space} spaceName={spaceName} />
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 max-w-[1280px] w-full mx-auto p-4 md:p-8 pb-20 md:pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
