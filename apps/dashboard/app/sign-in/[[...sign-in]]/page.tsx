// Sign-in uses Clerk's prebuilt component, styled by the provider in app/layout.tsx.
// Access is invite-only, so no sign-up link is shown.
import { Suspense } from 'react';
import { SignIn } from '@clerk/nextjs';
import { safeReturnTo } from '../../../lib/server/auth';

export const dynamic = 'force-dynamic';

export default function SignInPage({ searchParams }: { searchParams?: { returnTo?: string } }) {
  const returnTo = safeReturnTo(searchParams?.returnTo || '/app');
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="text-center">
        <h1 className="text-2xl font-serif font-bold text-[var(--color-brand)]">LogMem</h1>
        <p className="text-sm text-[var(--color-muted)]">Shared memory for autonomous agent teams</p>
      </div>
      {/* Catch-all Clerk pages read the URL, so they sit in a Suspense boundary. */}
      <Suspense>
        <SignIn routing="path" path="/sign-in" forceRedirectUrl={returnTo} />
      </Suspense>
      <p className="text-xs text-[var(--color-muted)]">Need an invitation? Contact your workspace administrator.</p>
    </main>
  );
}
