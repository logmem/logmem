'use client';

import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type'> {
  min?: number;
  max?: number;
  step?: number;
  value?: number[];
  defaultValue?: number[];
  onValueChange?: (value: number[]) => void;
}

export const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, min = 0, max = 100, step = 1, value, defaultValue, onValueChange, disabled, ...props }, ref) => {
    const [uncontrolled, setUncontrolled] = React.useState<number>(defaultValue?.[0] ?? min);
    const current = value?.[0] ?? uncontrolled;
    const pct = max > min ? Math.min(100, Math.max(0, ((current - min) / (max - min)) * 100)) : 0;

    return (
      <div
        data-slot="slider"
        className={cn(
          'relative flex h-6 w-full touch-none select-none items-center',
          disabled && 'opacity-50',
          className,
        )}
      >
        <div className="relative h-2 w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--surface-sunken)] ring-1 ring-inset ring-[var(--border)]">
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 rounded-[var(--radius-pill)] bg-[var(--brand)]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--brand)] bg-[var(--surface)] shadow-sm transition-transform"
          style={{ left: `${pct}%` }}
        />
        <input
          ref={ref}
          type="range"
          min={min}
          max={max}
          step={step}
          value={current}
          disabled={disabled}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (value === undefined) setUncontrolled(next);
            onValueChange?.([next]);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
          {...props}
        />
      </div>
    );
  },
);
Slider.displayName = 'Slider';

export default Slider;
