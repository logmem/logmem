import { NavRail } from './components/nav-rail';
import { requireSpace } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function WorkspaceSpaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  const viewer = await requireSpace(space, 'read');
  const spaceName = viewer.space?.name || space;
  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)] font-sans antialiased">
      <NavRail space={space} spaceName={spaceName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-[var(--content-max)] flex-1 p-4 pb-20 md:p-8 md:pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
