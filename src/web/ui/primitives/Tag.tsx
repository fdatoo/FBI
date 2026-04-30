import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Tag({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[12px] px-1.5 rounded-sm bg-surface-raised text-text-dim border border-border',
        className,
      )}
      {...rest}
    />
  );
}
