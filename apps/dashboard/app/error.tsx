'use client';

// Error boundary for the whole dashboard. lib/server/auth.ts throws on a Clerk,
// storage or configuration failure so that a failure is never shown as
// "signed out" or "no access". This screen is where those errors land.
// It shows no error detail: the message can name internal configuration.

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div role="alert" className="w-full max-w-lg p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm">
        <h1 className="text-xl font-serif font-bold text-[var(--color-brand)] mb-2">LogMem could not load this page</h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">
          Your sign-in and your access did not change. The service did not answer. Try again in a moment.
          {error.digest ? ` Reference: ${error.digest}.` : ''}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-[44px] items-center px-3 text-xs font-medium rounded bg-[var(--color-button-primary-bg)] text-[var(--color-button-primary-fg)] hover:opacity-90"
          >
            Try again
          </button>
          <a href="/select-space" className="inline-flex min-h-[44px] items-center px-3 text-xs font-medium underline">
            Back to your spaces
          </a>
        </div>
      </div>
    </main>
  );
}
