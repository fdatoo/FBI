import type { LabelHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export function FieldLabel({ className, ...rest }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('block font-mono text-[13px] uppercase tracking-wide text-text-dim mb-1', className)}
      {...rest}
    />
  );
}
