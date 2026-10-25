// apps/dashboard/app/(workspace)/select-space/page.tsx
// Space selector destination for authenticated users across multiple spaces.

export const dynamic = 'force-dynamic';

export default function SelectSpacePage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-fg)] p-4">
      <div className="w-full max-w-lg p-8 border border-[var(--color-border)] rounded-lg bg-[var(--color-surface)] shadow-sm">
        <h1 className="text-xl font-serif font-bold text-[var(--color-brand)] mb-2">Select a Space</h1>
        <p className="text-sm text-[var(--color-muted)] mb-6">Choose an authorized workspace and space to enter.</p>

        <div id="space-list" className="space-y-3 mb-6">
          {/* Populated client-side from /api/session or server component stream */}
          <div className="p-4 border border-[var(--color-border-subtle)] rounded bg-[var(--color-surface-elevated)] text-sm">
            Loading your spaces...
          </div>
        </div>

        <div className="pt-4 border-t border-[var(--color-border)] flex justify-between items-center">
          <a
            href="/app"
            className="text-xs text-[var(--color-muted)] hover:underline"
          >
            ← Return to Dashboard
          </a>
          <a
            href="/app?create=space"
            className="px-3 py-1.5 text-xs font-medium rounded bg-[var(--color-button-primary-bg)] text-[var(--color-button-primary-fg)] hover:opacity-90 transition-opacity"
          >
            + Create Space
          </a>
        </div>
      </div>
    </main>
  );
}
