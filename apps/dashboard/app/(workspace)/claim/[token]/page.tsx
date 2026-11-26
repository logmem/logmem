// Recipient 1-Click Space Claim page (/claim/[token]).
import Link from 'next/link';
import { customerRedis } from '../../../../../../src/http/jail.mjs';
import { inspectSpaceClaim } from '../../../../../../src/http/space-claims.mjs';
import { listMySpaces, requireSession } from '../../../../lib/server/auth';
import { ClaimSpaceClient } from './claim-client';

export const dynamic = 'force-dynamic';

export default async function ClaimSpacePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { session } = await requireSession(`/claim/${encodeURIComponent(token)}`);
  const redis = customerRedis(process.env);

  let preview: any = null;
  let errorMsg = '';
  try {
    preview = await inspectSpaceClaim(
      { token, verifiedEmail: session.email || '' },
      { redis },
    );
  } catch (e: any) {
    errorMsg = e?.message || 'This claim link is invalid, expired, or already used.';
  }

  const workspaces = await listMySpaces(`/claim/${encodeURIComponent(token)}`);
  const manageable = workspaces
    .filter((w: any) => w.role === 'owner' || w.role === 'admin')
    .map((w: any) => ({ id: w.id, name: w.name, role: w.role }));

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-4 text-[var(--text)] font-sans antialiased">
      {preview ? (
        <ClaimSpaceClient
          token={token}
          preview={preview}
          workspaces={manageable}
          signedInEmail={session.email || ''}
        />
      ) : (
        <div className="w-full max-w-lg rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] p-6 space-y-4">
          <h1 className="font-heading text-xl font-bold text-[var(--brand)]">
            Claim link unavailable
          </h1>
          <p role="alert" className="text-sm text-[var(--text-muted)]">
            {errorMsg}
          </p>
          <p className="text-xs text-[var(--text-subtle)]">
            Signed in as <strong>{session.email || session.userId}</strong>. Claim links work once and expire automatically.
          </p>
          <Link
            href="/select-space"
            className="inline-flex min-h-[40px] items-center rounded-[var(--radius-md)] bg-[var(--brand)] px-4 text-xs font-semibold text-[var(--surface)]"
          >
            Go to my spaces
          </Link>
        </div>
      )}
    </main>
  );
}
