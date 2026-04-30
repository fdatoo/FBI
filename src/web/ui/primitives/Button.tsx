import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-surface hover:bg-accent-strong border-accent',
  secondary: 'bg-accent-subtle text-accent-strong border-accent-subtle hover:border-accent',
  ghost: 'bg-transparent text-text-dim border-border-strong hover:bg-surface-raised hover:text-text',
  danger: 'bg-fail-subtle text-fail border-fail-subtle hover:border-fail',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'text-[13px] px-2.5 py-1',
  md: 'text-xs px-3 py-1.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      data-variant={variant}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium rounded-md border transition-colors duration-fast ease-out disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    />
  );
});
