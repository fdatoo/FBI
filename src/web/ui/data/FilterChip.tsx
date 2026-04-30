import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface FilterChipProps extends HTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function FilterChip({ active, className, ...rest }: FilterChipProps) {
  return (
    <button
      type="button"
      data-active={active ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[13px] font-mono border transition-colors duration-fast ease-out',
        active
          ? 'bg-accent-subtle text-accent-strong border-accent'
          : 'bg-surface-raised text-text-dim border-border hover:text-text',
        className,
      )}
      {...rest}
    />
  );
}
