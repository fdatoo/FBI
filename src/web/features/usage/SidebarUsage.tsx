import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useUsage, useUsageUpdatedAt } from './useUsage.js';
import type { UsageBucket, PacingVerdict } from '@shared/types.js';
import { cn } from '../../ui/cn.js';
import { pacingDisplay, PACING_TONE_CLASS } from './pacingDisplay.js';

const LABELS: Record<string, string> = {
  five_hour: '5h', weekly: 'weekly', sonnet_weekly: 'sonnet',
};

function formatAge(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return '';
  const s = Math.floor((now - updatedAt) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function formatReset(ms: number | null, now: number): string {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor((ms - now) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function toneForUtil(u: number): 'ok' | 'warn' | 'fail' {
  if (u >= 0.9) return 'fail';
  if (u >= 0.75) return 'warn';
  return 'ok';
}

export interface SidebarUsageProps {
  collapsed?: boolean;
}

export function SidebarUsage({ collapsed = false }: SidebarUsageProps) {
  const s = useUsage();
  const updatedAt = useUsageUpdatedAt();
  const [now, setNow] = useState(() => Date.now());

  // Tick every 10s so the "X ago" label stays fresh.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    tickRef.current = setInterval(() => setNow(Date.now()), 10_000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  if (!s || s.last_error) {
    return (
      <NavLink
        to="/usage"
        className="block px-3 py-2 text-[12px] text-text-faint hover:bg-surface-raised border-t border-border-strong"
        title={s?.last_error ?? 'Loading…'}
        aria-label="Usage"
      >
        {collapsed ? <span className="flex justify-center">·</span> : 'Usage unavailable'}
      </NavLink>
    );
  }

  if (collapsed) {
    const worst = s.buckets.reduce((m, b) => b.utilization > m ? b.utilization : m, 0);
    const tone = toneForUtil(worst);
    const dotClass = tone === 'fail' ? 'bg-fail' : tone === 'warn' ? 'bg-warn' : 'bg-ok';
    const pctClass = tone === 'fail' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-ok';
    const tooltip = s.buckets
      .map(b => `${LABELS[b.id] ?? b.id} ${Math.round(b.utilization * 100)}%`)
      .join(' · ');
    return (
      <NavLink
        to="/usage"
        className="flex flex-col items-center gap-0.5 py-2 border-t border-border-strong hover:bg-surface-raised"
        title={tooltip || 'Usage'}
        aria-label="Usage"
      >
        <span className={cn('font-mono text-[10px] leading-none', pctClass)}>
          {Math.round(worst * 100)}%
        </span>
        <span className={cn('w-2 h-2 rounded-full', dotClass)} />
      </NavLink>
    );
  }

  const age = formatAge(updatedAt, now);

  return (
    <NavLink
      to="/usage"
      aria-label="Usage"
      className="block px-2 py-2 border-t border-border-strong hover:bg-surface-raised"
    >
      <div className="flex items-center mb-1 px-1">
        <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint">Usage</span>
        {age && <span className="ml-auto text-[10px] text-text-faint font-mono">{age}</span>}
      </div>
      {s.buckets.map(b => (
        <Row key={b.id} bucket={b} pacing={s.pacing[b.id]} now={now} />
      ))}
    </NavLink>
  );
}

function PacingLabel({ pacing }: { pacing: PacingVerdict | undefined }) {
  if (!pacing) return null;
  const d = pacingDisplay(pacing);
  if (!d) return null;
  return (
    <span className={cn('ml-auto flex items-center gap-1 opacity-65', PACING_TONE_CLASS[d.tone])}>
      <span>{d.label}</span>
      <span className="font-mono">{d.deltaPct}</span>
    </span>
  );
}

function Row({ bucket: b, pacing, now }: { bucket: UsageBucket; pacing: PacingVerdict | undefined; now: number }) {
  const pct = Math.round(b.utilization * 100);
  const tone = toneForUtil(b.utilization);
  const barClass = tone === 'fail' ? 'bg-fail' : tone === 'warn' ? 'bg-warn' : 'bg-ok';
  const pctClass = tone === 'fail' ? 'text-fail' : tone === 'warn' ? 'text-warn' : 'text-ok';
  return (
    <div className="mb-1 px-1">
      <div className="flex items-center text-[12px]">
        <span className="text-text-dim">{LABELS[b.id] ?? b.id}</span>
        <span className={cn('ml-auto font-mono', pctClass)}>{pct}%</span>
      </div>
      <div className="h-1 rounded-full bg-surface-raised overflow-hidden my-0.5">
        <div className={cn('h-full', barClass)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center text-[10px] text-text-faint">
        <span>{formatReset(b.reset_at, now)}</span>
        <PacingLabel pacing={pacing} />
      </div>
    </div>
  );
}
