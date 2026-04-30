import { useUsage } from './useUsage.js';

const LABEL: Record<string, string> = { five_hour: '5-hour', weekly: 'weekly', sonnet_weekly: 'Sonnet weekly' };

export function UsageWarning() {
  const s = useUsage();
  if (!s) return null;
  const bad = s.buckets.find(b => b.utilization >= 0.9);
  if (!bad) return null;
  const pct = Math.round(bad.utilization * 100);
  return (
    <div role="alert" className="p-3 border border-warn bg-warn-subtle text-warn rounded-md text-[14px] font-mono">
      ⚠ Claude {LABEL[bad.id] ?? bad.id} usage {pct}%. Starting a new run is allowed but may hit the limit.
    </div>
  );
}
