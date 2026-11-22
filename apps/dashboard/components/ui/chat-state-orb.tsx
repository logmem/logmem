export type OrbState =
  | 'idle'
  | 'working'
  | 'reasoning'
  | 'searching'
  | 'retrying'
  | 'compacting'
  | 'waiting';

export function ChatStateOrb({
  state,
  label,
}: {
  state: OrbState;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]" role="status">
      <span className="lm-orb" data-state={state} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
