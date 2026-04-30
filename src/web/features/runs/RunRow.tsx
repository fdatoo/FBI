import { NavLink } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { Kbd } from '@ui/primitives/Kbd.js';
import type { Run } from '@shared/types.js';

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  starting: 'run',
  running: 'run',
  waiting: 'attn',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'wait',
  resume_failed: 'fail',
};

const MOD_SYMBOL = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl ';

export interface RunRowProps {
  run: Run;
  to: string;
  /** When provided, renders a keyboard shortcut hint badge (e.g. "1" → "⌘1"). */
  shortcutLabel?: string;
}

export function RunRow({ run, to, shortcutLabel }: RunRowProps) {
  const label = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  return (
    <NavLink
      to={to}
      data-context-id="run-row"
      data-context-run-id={String(run.id)}
      data-context-branch={run.branch_name ?? ''}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 py-1.5 border-b border-border text-[14px] transition-colors duration-fast ease-out ${
          isActive ? 'bg-accent-subtle text-accent-strong' : 'text-text-dim hover:bg-surface-raised hover:text-text'
        }`
      }
    >
      <span className="font-mono text-[13px] w-8 text-text-faint">#{run.id}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {run.tokens_input + run.tokens_output > 0 && (
        <span className="font-mono text-[12px] text-text-faint">{fmt(run.tokens_input + run.tokens_output)}</span>
      )}
      {shortcutLabel && (
        <Kbd className="text-[11px] shrink-0">{MOD_SYMBOL}{shortcutLabel}</Kbd>
      )}
      <Pill tone={TONE[run.state]}>{run.state}</Pill>
      <time
        dateTime={new Date(run.state_entered_at).toISOString()}
        title={`entered ${run.state} at ${new Date(run.state_entered_at).toLocaleString()}`}
        className="font-mono text-[13px] text-text-faint"
      >
        {formatRelative(run.state_entered_at)}
      </time>
    </NavLink>
  );
}

function formatRelative(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 10) return 'now';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
}
