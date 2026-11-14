// Lists only the spaces this person belongs to. One space goes straight to Today.
import { redirect } from 'next/navigation';
import { listMySpaces, spacePath, validSpaceId } from '../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function SelectSpacePage() {
  const workspaces = await listMySpaces('/select-space');
  const spaces = workspaces.flatMap((w) =>
    w.spaces
      .filter((s) => validSpaceId(s.id))
      .map((s) => ({ ...s, workspaceName: w.name })),
  );
  if (spaces.length === 1) redirect(spacePath(spaces[0].id, 'today'));

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="w-full max-w-lg p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm">
        <h1 className="text-xl font-serif font-bold text-[var(--color-brand)] mb-2">Select a space</h1>
        {spaces.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            You are not in a space yet. Ask a workspace admin for an invitation.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-muted)] mb-6">Choose a space to enter.</p>
            <ul className="space-y-3">
              {spaces.map((s) => (
                <li key={s.id}>
                  <a
                    href={spacePath(s.id, 'today')}
                    className="flex min-h-[44px] flex-col justify-center p-4 border border-[var(--color-border-subtle)] rounded bg-[var(--color-surface-elevated)] text-sm hover:border-[var(--color-brand)]"
                  >
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-[var(--color-muted)]">{s.workspaceName}</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
