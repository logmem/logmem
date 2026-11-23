export type KindGroup = 'work' | 'handoff' | 'signal' | 'decision' | 'error' | 'system' | 'neutral';

const KIND_GROUPS: Record<string, KindGroup> = {
  assigned: 'work',
  progress: 'work',
  done: 'work',
  shared: 'work',
  research: 'work',
  checkup: 'work',
  feedback: 'work',
  handoff: 'handoff',
  accepted: 'handoff',
  stuck: 'signal',
  alert: 'signal',
  memo: 'signal',
  huddle: 'signal',
  approval: 'decision',
  decided: 'decision',
  pivot: 'decision',
  problem: 'error',
  fix: 'error',
  started: 'system',
  ping: 'system',
  recap: 'system',
  joined: 'system',
  setup: 'system',
};

export function kindGroup(kind?: string | null): KindGroup {
  if (!kind) return 'neutral';
  return KIND_GROUPS[String(kind).toLowerCase()] || 'neutral';
}

export function KindChip({ kind }: { kind?: string | null }) {
  const label = kind ? String(kind) : 'entry';
  const group = kindGroup(kind);
  return (
    <span className="lm-kind-chip" data-group={group === 'neutral' ? undefined : group}>
      {label}
    </span>
  );
}
