import { requireSpace } from '../../../../../lib/server/auth';
import { getAccessData } from '../../../../../lib/server/access';
import { PageHeader, ReadOnlyFlag, StatePanel } from '../../../../../components/ui';
import { ConnectSnippetPanel } from '../components/access-view';

export const dynamic = 'force-dynamic';

export default async function AccessPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  await requireSpace(space, 'read');
  const { flags, snippets, unavailable } = await getAccessData(space);

  return (
    <div className="space-y-6 font-sans">
      <PageHeader
        title="Agent access"
        subtitle={`Read-only space environment status and setup snippets for space:${space}.`}
      />

      {unavailable ? (
        <StatePanel
          variant="error"
          title="Space status could not be read right now."
          detail="Environment flags are temporarily unavailable. Reload to try again."
        />
      ) : (
        <section
          aria-labelledby="access-flags-h"
          className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)]"
        >
          <div className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-2.5">
            <h2 id="access-flags-h" className="font-heading text-sm font-semibold text-[var(--text)]">
              Environment &amp; storage flags (read only)
            </h2>
          </div>
          {flags.map((f) => (
            <ReadOnlyFlag
              key={f.id}
              label={f.label}
              hint={f.hint}
              envVar={f.envVar}
              value={f.value}
              tone={f.tone}
            />
          ))}
        </section>
      )}

      <ConnectSnippetPanel snippets={snippets} />
    </div>
  );
}
