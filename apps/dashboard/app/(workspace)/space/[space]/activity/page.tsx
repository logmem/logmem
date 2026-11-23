import { requireSpace } from '../../../../../lib/server/auth';
import { getActivityData } from '../../../../../lib/server/activity';
import { PageHeader, StatePanel, StatusStrip } from '../../../../../components/ui';
import { ActivityView } from '../components/activity-view';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const { entries, coverageNote, unavailable, now } = await getActivityData(space);

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Activity"
        subtitle={`Newest-first entries in space:${space} · LogMem never rewrites what an agent wrote.`}
      />

      {coverageNote && !unavailable ? (
        <StatusStrip message={coverageNote} tone="info" dismissible={false} />
      ) : null}

      {unavailable ? (
        <StatePanel
          variant="error"
          title="Activity log could not be read right now."
          detail="Nothing is shown because an empty log would be wrong. Reload to try again."
        />
      ) : (
        <ActivityView entries={entries} now={now} />
      )}
    </div>
  );
}
