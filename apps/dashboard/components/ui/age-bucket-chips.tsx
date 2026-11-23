'use client';

export interface BucketOption<T extends string = string> {
  id: T;
  label: string;
  count: number;
  alwaysEnabled?: boolean;
}

export function AgeBucketChips<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel = 'Filter items',
}: {
  options: Array<BucketOption<T>>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="lm-age-chips" role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = value === opt.id;
        const disabled = !active && !opt.alwaysEnabled && opt.count === 0;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(opt.id)}
            className="lm-age-chip"
          >
            <span>{opt.label}</span>
            <span className="lm-age-chip-count">{opt.count}</span>
          </button>
        );
      })}
    </div>
  );
}
