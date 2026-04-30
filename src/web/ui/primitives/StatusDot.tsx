import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type DotTone = 'ok' | 'run' | 'attn' | 'fail' | 'warn';

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone: DotTone;
}

const DOT: Record<DotTone, string> = {
  ok: 'bg-ok',
  run: 'bg-run shadow-[0_0_6px_var(--run)] animate-pulse',
  attn: 'bg-attn shadow-[0_0_6px_var(--attn)] animate-pulse',
  fail: 'bg-fail',
  warn: 'bg-warn',
};

export function StatusDot({ tone, className, ...rest }: StatusDotProps) {
  return (
    <span
      role="img"
      data-tone={tone}
      className={cn('inline-block w-[7px] h-[7px] rounded-full', DOT[tone], className)}
      {...rest}
    />
  );
}
