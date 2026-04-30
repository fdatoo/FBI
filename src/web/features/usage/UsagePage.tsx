import { useEffect, useState } from 'react';
import { useUsage } from './useUsage.js';
import { api } from '../../lib/api.js';
import type { DailyUsage, Run, UsageBucket, PacingVerdict } from '@shared/types.js';
import { cn } from '../../ui/cn.js';
import { pacingDisplay, PACING_TONE_CLASS } from './pacingDisplay.js';

const LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  weekly: 'Weekly',
  sonnet_weekly: 'Sonnet weekly',
};

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtCountdown(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function fmtAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function toneBar(pct: number): string {
  if (pct >= 90) return 'bg-fail';
  if (pct >= 75) return 'bg-warn';
  return 'bg-ok';
}

export function UsagePage() {
  const s = useUsage();
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <h1 className="text-lg font-semibold">Claude usage</h1>
      {!s || s.last_error ? (
        <ErrorPanel state={s} />
      ) : (
        <>
          {s.buckets.length === 0 ? (
            <div className="p-4 border border-border rounded-md text-text-faint">
              No buckets observed yet. Waiting for the next poll.
            </div>
          ) : (
            <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {s.buckets.map(b => (
                <BucketCard key={b.id} bucket={b} pacing={s.pacing[b.id]} />
              ))}
            </section>
          )}
          <DailySection />
          <PerRunSection />
          <Footer observedAt={s.observed_at} plan={s.plan} lastError={s.last_error} />
        </>
      )}
    </div>
  );
}

function ErrorPanel({ state }: { state: ReturnType<typeof useUsage> }) {
  return (
    <div className="p-4 border border-border rounded-md text-text-faint">
      {!state && 'Loading usage…'}
      {state?.last_error === 'missing_credentials' && (<>Sign in to Claude on the host: <code>claude /login</code></>)}
      {state?.last_error === 'expired' && (<>Token expired. Run <code>claude /login</code> on the host.</>)}
      {state?.last_error === 'rate_limited' && 'Anthropic rate-limited the usage API. Retrying every 5 min.'}
      {state?.last_error === 'network' && 'Network error contacting Anthropic. Retrying every 5 min.'}
    </div>
  );
}

function BucketCard({ bucket: b, pacing }: { bucket: UsageBucket; pacing: PacingVerdict | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const pct = Math.round(b.utilization * 100);
  const countdown = b.reset_at ? Math.max(0, b.reset_at - now) : 0;
  return (
    <div className="p-4 border border-border rounded-md">
      <div className="text-[13px] text-text-dim">{LABELS[b.id] ?? b.id}</div>
      <div className="text-3xl font-mono mt-1">{pct}%</div>
      <div className="h-2 bg-surface-raised rounded-full overflow-hidden my-2">
        <div className={cn('h-full', toneBar(pct))} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-[12px] text-text-dim">resets in {fmtCountdown(countdown)}</div>
      {b.reset_at && <div className="text-[11px] text-text-faint">{new Date(b.reset_at).toLocaleString()}</div>}
      <PacingBadge pacing={pacing} />
    </div>
  );
}

function PacingBadge({ pacing }: { pacing: PacingVerdict | undefined }) {
  if (!pacing) return null;
  const d = pacingDisplay(pacing);
  if (!d) return null;
  return (
    <div className="mt-2 text-[12px]">
      <span className={cn('font-medium', PACING_TONE_CLASS[d.tone])}>{d.label}</span>
      <span className={cn('ml-2 font-mono', PACING_TONE_CLASS[d.tone])}>{d.deltaPct}</span>
    </div>
  );
}

function DailySection() {
  const [rows, setRows] = useState<DailyUsage[]>([]);
  const [days, setDays] = useState(14);
  useEffect(() => {
    let stop = false;
    void api.listDailyUsage(days).then((r) => { if (!stop) setRows(r); }).catch(() => {});
    return () => { stop = true; };
  }, [days]);
  const max = Math.max(1, ...rows.map(r => r.tokens_total));
  const totalCached = rows.reduce((sum, r) => sum + r.tokens_cache_read + r.tokens_cache_create, 0);
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-[13px] font-semibold">Daily tokens (input + output)</h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-[12px] bg-surface border border-border rounded px-1">
          <option value={7}>7 days</option>
          <option value={14}>14 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <div className="text-text-faint text-[12px]">No usage recorded yet.</div>
      ) : (
        <>
          <div className="flex items-end gap-1 h-24">
            {rows.map(r => (
              <div
                key={r.date}
                className="flex-1 min-w-[4px] bg-accent hover:bg-accent-strong transition-colors"
                style={{ height: `${Math.max(1, Math.round((r.tokens_total / max) * 100))}%` }}
                title={`${r.date}: ${fmtNum(r.tokens_total)} billable (+${fmtNum(r.tokens_cache_read + r.tokens_cache_create)} cached)`}
              />
            ))}
          </div>
          <div className="text-[11px] text-text-faint mt-1">+{fmtNum(totalCached)} cached tokens (not billable)</div>
        </>
      )}
    </section>
  );
}

function PerRunSection() {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    let stop = false;
    void api.listRunsPaged({ limit: 20, offset: 0 }).then((r) => { if (!stop) setRuns(r.items); }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return (
    <section>
      <h2 className="text-[13px] font-semibold mb-2">Recent runs</h2>
      {runs.length === 0 ? (
        <div className="text-text-faint text-[12px]">No runs yet.</div>
      ) : (
        <table className="w-full text-[12px]">
          <thead><tr className="text-text-faint text-left">
            <th className="py-1">run</th>
            <th className="py-1 text-right">input</th>
            <th className="py-1 text-right">output</th>
            <th className="py-1 text-right">cached</th>
            <th className="py-1 text-right">total</th>
          </tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id} className="border-t border-border">
                <td className="py-1"><a className="text-accent-strong hover:underline" href={`/projects/${r.project_id}/runs/${r.id}`}>#{r.id}</a></td>
                <td className="py-1 text-right font-mono">{fmtNum(r.tokens_input)}</td>
                <td className="py-1 text-right font-mono">{fmtNum(r.tokens_output)}</td>
                <td className="py-1 text-right font-mono text-text-faint">{fmtNum(r.tokens_cache_read + r.tokens_cache_create)}</td>
                <td className="py-1 text-right font-mono">{fmtNum(r.tokens_input + r.tokens_output)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Footer({ observedAt, plan, lastError }: { observedAt: number | null; plan: string | null; lastError: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return (
    <footer className="text-[11px] text-text-faint font-mono">
      <span>plan: {plan ?? '—'}</span>
      {observedAt != null && <span className="ml-4">as of {fmtAgo(now - observedAt)} ago</span>}
      {lastError && <span className="ml-4">last error: {lastError}</span>}
    </footer>
  );
}
