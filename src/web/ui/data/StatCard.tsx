import { cn } from '../cn.js';

export type StatTone = 'default' | 'accent' | 'ok' | 'fail' | 'warn';

export interface StatCardProps {
  label: string;
  value: string | number;
  delta?: string;
  tone?: StatTone;
}

const TONE: Record<StatTone, string> = {
  default: 'text-text',
  accent: 'text-accent',
  ok: 'text-ok',
  fail: 'text-fail',
  warn: 'text-warn',
};

export function StatCard({ label, value, delta, tone = 'default' }: StatCardProps) {
  return (
    <div className="bg-surface border border-border-strong rounded-lg px-4 py-2.5 min-w-[110px] flex flex-col gap-0.5">
      <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">{label}</span>
      <span className={cn('font-mono text-[20px] font-semibold tracking-[-0.02em]', TONE[tone])}>{value}</span>
      {delta && <span className="font-mono text-[12px] text-ok">{delta}</span>}
    </div>
  );
}
