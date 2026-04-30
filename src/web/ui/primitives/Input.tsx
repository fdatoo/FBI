import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'bg-surface-sunken text-text placeholder:text-text-faint border border-border-strong rounded-md px-3 py-1.5 text-sm font-mono',
        'focus:outline-none focus:border-accent focus:shadow-focus transition-[border,box-shadow] duration-fast ease-out',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      {...rest}
    />
  );
});
