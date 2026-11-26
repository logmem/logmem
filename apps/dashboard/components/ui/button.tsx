import * as React from 'react';
import { cn } from '../../lib/utils';

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  default: 'bg-[var(--brand)] text-[var(--on-brand)] hover:bg-[var(--brand-hover)]',
  destructive: 'bg-[var(--danger)] text-[var(--text-inverse)] hover:opacity-90',
  outline:
    'border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-sunken)]',
  secondary:
    'bg-[var(--surface-sunken)] text-[var(--text)] border border-[var(--border)] hover:border-[var(--border-strong)]',
  ghost: 'bg-transparent text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]',
  link: 'bg-transparent text-[var(--link)] underline-offset-4 hover:underline',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: 'h-10 px-4 py-2',
  sm: 'h-9 rounded-[var(--radius-md)] px-3',
  lg: 'h-11 rounded-[var(--radius-md)] px-8',
  icon: 'h-10 w-10',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
