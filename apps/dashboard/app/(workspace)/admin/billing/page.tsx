import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '../../../../components/ui';
import { getAdminBillingData } from '../../../../lib/server/billing';
import { ACCESS_DENIED_PATH } from '../../../../lib/server/routes.mjs';
import { AdminBillingView } from './admin-billing-view';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export default async function AdminBillingPage() {
  let initial;
  try {
    initial = await getAdminBillingData();
  } catch (err: any) {
    if (err?.status === 403 || err?.code === 'forbidden') {
      redirect(ACCESS_DENIED_PATH);
    }
    throw err;
  }

  return (
    <div className="mx-auto w-full max-w-[var(--content-max)] p-4 pb-20 md:p-8 space-y-6 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/select-space"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Back to spaces</span>
        </Link>
        <span className="rounded-full border border-[var(--brand)] bg-[var(--brand-subtle)] px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-[var(--brand)]">
          Deploy {initial.actor.role}
        </span>
      </div>

      <PageHeader
        title="Subscription & Billing Admin"
        subtitle="Inspect all Clerk workspaces, override plan tiers or custom quotas, and review billing audit events."
      />

      <AdminBillingView initial={initial} />
    </div>
  );
}
