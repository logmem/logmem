import { Suspense } from 'react';
import { PageHeader } from '../../../../../components/ui';
import { requireSpace } from '../../../../../lib/server/auth';
import { getSpaceSettingsData } from '../../../../../lib/server/portability';
import { getSpaceBillingData } from '../../../../../lib/server/billing';
import { SpaceSettingsView } from '../components/settings-view';

export const dynamic = 'force-dynamic';

export default async function SpaceSettingsPage({
  params,
}: {
  params: Promise<{ space: string }>;
}) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const [data, billing] = await Promise.all([
    getSpaceSettingsData(space),
    getSpaceBillingData(space),
  ]);

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Space settings"
        subtitle={`Members, RBAC, subscription limits, and portable export/import for ${data.spaceName}.`}
      />
      <Suspense fallback={<div className="text-xs text-[var(--text-muted)]">Loading settings…</div>}>
        <SpaceSettingsView initial={data} billing={billing} />
      </Suspense>
    </div>
  );
}
