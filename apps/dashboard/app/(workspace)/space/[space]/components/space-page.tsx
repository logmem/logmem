import { PageHeader, StatePanel } from '../../../../../components/ui';

export function SpacePage({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-6 font-sans">
      <PageHeader title={title} />
      <StatePanel variant="empty" title={body} />
    </div>
  );
}
