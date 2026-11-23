export function ReadOnlyFlag({
  label,
  value,
  hint,
  envVar,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  envVar?: string;
  tone?: 'ok' | 'warn' | 'danger' | 'neutral';
}) {
  return (
    <div className="lm-readonly-flag">
      <div className="lm-readonly-flag-info">
        <span className="lm-readonly-flag-label">{label}</span>
        {(hint || envVar) ? (
          <span className="lm-readonly-flag-hint">
            {hint ? `${hint} ` : ''}
            {envVar ? <code>{envVar}</code> : null}
          </span>
        ) : null}
      </div>
      <span
        className="lm-readonly-flag-chip"
        data-tone={tone === 'neutral' ? undefined : tone}
      >
        {value}
      </span>
    </div>
  );
}
