import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'w-full bg-surface text-text border border-border-strong rounded-md px-2.5 py-1.5 text-sm outline-none transition-shadow duration-fast ease-out focus:border-accent focus:shadow-focus',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
