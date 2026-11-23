import { requireSpace } from '../../../../../lib/server/auth';
import { getWorkData } from '../../../../../lib/server/work';
import { PageHeader, StatePanel } from '../../../../../components/ui';
import { WorkView } from '../components/work-view';

export const dynamic = 'force-dynamic';

export default async function WorkPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const { jobs, unavailable, now } = await getWorkData(space);

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Work"
        subtitle={`Jobs in space:${space} · one owner, one stage, and its own log.`}
      />
      {unavailable ? (
        <StatePanel
          variant="error"
          title="Jobs could not be read right now."
          detail="Nothing is shown because an empty list would be wrong. Reload to try again."
        />
      ) : (
        <WorkView jobs={jobs} now={now} />
      )}
    </div>
  );
}
