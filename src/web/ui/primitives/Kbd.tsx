import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center min-w-[16px] px-1.5 font-mono text-[12px] font-medium rounded-sm bg-surface-raised text-text-dim border border-border-strong',
        className,
      )}
      {...rest}
    />
  );
}
