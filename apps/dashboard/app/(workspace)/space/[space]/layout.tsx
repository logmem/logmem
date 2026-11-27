import { NavRail, type SwitcherSpace } from './components/nav-rail';
import { listMySpaces, requireSpace, validSpaceId } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export default async function WorkspaceSpaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  const [viewer, workspaces] = await Promise.all([
    requireSpace(space, 'read'),
    listMySpaces(`/space/${space}/today`).catch(() => []),
  ]);
  const spaceName = viewer.space?.name || space;
  const switcherSpaces: SwitcherSpace[] = workspaces.flatMap((w: any) =>
    (w.spaces || [])
      .filter((s: any) => validSpaceId(s.id))
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        workspaceName: w.name,
        role: w.role || (s.permissions?.write ? 'editor' : 'viewer'),
      })),
  );

  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)] font-sans antialiased">
      <NavRail
        space={space}
        spaceName={spaceName}
        spaces={switcherSpaces}
        canCreateSpace={Boolean(viewer.permissions?.canCreateSpace)}
        canImport={Boolean(viewer.permissions?.canImport)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="mx-auto w-full max-w-[var(--content-max)] flex-1 p-4 pb-20 md:p-8 md:pb-8">
          {children}
        </main>
      </div>
    </div>
  );
}
