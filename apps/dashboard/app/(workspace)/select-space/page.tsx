// apps/dashboard/app/(workspace)/select-space/page.tsx
// Lists only the spaces this person belongs to. One space goes straight to Today.
import { redirect } from 'next/navigation';
import { listMySpaces } from '../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function SelectSpacePage() {
  const workspaces = await listMySpaces('/app');
  const spaces = workspaces.flatMap((w) => w.spaces.map((s) => ({ ...s, workspaceName: w.name })));
  if (spaces.length === 1) redirect(`/app/${spaces[0].id}/today`);

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="w-full max-w-lg p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm">
        <h1 className="text-xl font-serif font-bold text-[var(--color-brand)] mb-2">Select a space</h1>
        {spaces.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)] mb-6">
            You have no workspace yet. Create one to get started.
          </p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-muted)] mb-6">Choose a space to enter.</p>
            <ul className="space-y-3 mb-6">
              {spaces.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/app/${s.id}/today`}
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
        <div className="pt-4 border-t border-[var(--color-border)] flex justify-end">
          <a
            href="/app?create=space"
            className="inline-flex min-h-[44px] items-center px-3 text-xs font-medium rounded bg-[var(--color-button-primary-bg)] text-[var(--color-button-primary-fg)] hover:opacity-90"
          >
            + Create space
          </a>
        </div>
      </div>
    </main>
  );
}
