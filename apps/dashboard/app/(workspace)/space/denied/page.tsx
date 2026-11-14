import { requireSession } from '../../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default async function SpaceDeniedPage() {
  await requireSession('/select-space');
  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="w-full max-w-lg p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm">
        <h1 className="text-xl font-serif font-bold text-[var(--color-brand)] mb-2">You don&apos;t have access to this space</h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">
          Your account is signed in. This space is not one you can open. Ask a workspace admin if you need an invitation.
        </p>
        <a
          href="/select-space"
          className="inline-flex min-h-[44px] items-center px-3 text-xs font-medium rounded bg-[var(--color-button-primary-bg)] text-[var(--color-button-primary-fg)] hover:opacity-90"
        >
          Back to your spaces
        </a>
      </div>
    </main>
  );
}
