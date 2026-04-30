import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function CodeBlock({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code
      className={cn('font-mono text-[13px] px-1.5 py-0.5 rounded-sm bg-surface-raised border border-border', className)}
      {...rest}
    />
  );
}
