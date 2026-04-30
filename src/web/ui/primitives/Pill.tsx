import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type PillTone = 'ok' | 'run' | 'attn' | 'fail' | 'warn' | 'wait';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: PillTone;
}

// NOTE: Tailwind's `/<opacity>` modifier (e.g. `border-ok/40`) doesn't work
// with CSS-variable-backed colors when the variable holds a hex value rather
// than space-separated RGB. Using full-tone borders instead — the tone text
// colour matches so it reads as a coherent chip.
const TONES: Record<PillTone, string> = {
  ok: 'bg-ok-subtle text-ok border-ok',
  run: 'bg-run-subtle text-run border-run animate-pulse',
  attn: 'bg-attn-subtle text-attn border-attn animate-pulse',
  fail: 'bg-fail-subtle text-fail border-fail',
  warn: 'bg-warn-subtle text-warn border-warn',
  wait: 'bg-surface-raised text-text-dim border-border-strong',
};

export function Pill({ tone, className, ...rest }: PillProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[12px] font-medium px-1.5 rounded-sm border',
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}
