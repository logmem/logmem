// apps/dashboard/app/sign-in/[[...sign-in]]/page.tsx
// Sign-in view for the customer dashboard matching LogMem design tokens.

export const dynamic = 'force-dynamic';

export default function SignInPage({
  searchParams,
}: {
  searchParams?: { returnTo?: string };
}) {
  const returnTo = searchParams?.returnTo || '/app';

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="w-full max-w-md p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm text-center">
        <h1 className="text-2xl font-serif font-bold text-[var(--color-brand)] mb-2">LogMem</h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">Shared memory for autonomous agent teams</p>
        
        <div className="space-y-4">
          <a
            href={`/api/session?signin=1&returnTo=${encodeURIComponent(returnTo)}`}
            className="inline-flex items-center justify-center w-full px-4 py-2.5 text-sm font-medium rounded-md bg-[var(--color-button-primary-bg)] text-[var(--color-button-primary-fg)] hover:opacity-90 transition-opacity"
          >
            Sign in with Clerk
          </a>
        </div>

        <p className="text-xs text-[var(--color-muted)] mt-6">
          Need an invitation? Contact your workspace administrator.
        </p>
      </div>
    </main>
  );
}
