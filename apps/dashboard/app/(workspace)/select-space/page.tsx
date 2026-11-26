// Lists only the spaces this person belongs to. One space goes straight to Today unless creating/importing.
import { redirect } from 'next/navigation';
import { listMySpaces, spacePath, validSpaceId } from '../../../lib/server/auth';
import { SelectSpaceClient, type SelectableSpace, type SelectableWorkspace } from './select-space-client';

export const dynamic = 'force-dynamic';

export default async function SelectSpacePage({
  searchParams,
}: {
  searchParams?: Promise<{ create?: string; import?: string }>;
}) {
  const sp = (await searchParams) || {};
  const initialMode = sp.import === '1' ? 'import' : sp.create === '1' ? 'create' : null;
  const workspaces = await listMySpaces('/select-space');
  const wsList: SelectableWorkspace[] = workspaces.map((w: any) => ({
    id: w.id,
    name: w.name,
    role: w.role || 'member',
  }));
  const spaces: SelectableSpace[] = workspaces.flatMap((w: any) =>
    w.spaces
      .filter((s: any) => validSpaceId(s.id))
      .map((s: any) => ({
        id: s.id,
        name: s.name,
        workspaceId: w.id,
        workspaceName: w.name,
        role: w.role || (s.permissions?.write ? 'editor' : 'viewer'),
        canApprove: Boolean(s.permissions?.approve),
      })),
  );
  if (spaces.length === 1 && !initialMode) redirect(spacePath(spaces[0].id, 'today'));

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-4 text-[var(--text)] font-sans antialiased">
      <SelectSpaceClient workspaces={wsList} spaces={spaces} initialMode={initialMode} />
    </main>
  );
}
