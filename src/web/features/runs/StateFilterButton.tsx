import { useEffect, useRef, useState } from 'react';
import type { RunState } from '@shared/types.js';
import type { RunsView } from './useRunsView.js';
import { IconButton } from '@ui/primitives/IconButton.js';
import { Checkbox } from '@ui/primitives/Checkbox.js';
import { cn } from '@ui/cn.js';

const ORDER: readonly { state: RunState; label: string }[] = [
  { state: 'starting',        label: 'starting'  },
  { state: 'running',         label: 'running'   },
  { state: 'waiting',         label: 'waiting'   },
  { state: 'awaiting_resume', label: 'awaiting'  },
  { state: 'queued',          label: 'queued'    },
  { state: 'succeeded',       label: 'succeeded' },
  { state: 'failed',          label: 'failed'    },
  { state: 'cancelled',       label: 'cancelled' },
];

const DOT_TONE: Record<RunState, string> = {
  starting:        'bg-run',
  running:         'bg-run',
  waiting:         'bg-attn',
  awaiting_resume: 'bg-warn',
  queued:          'bg-text-faint',
  succeeded:       'bg-ok',
  failed:          'bg-fail',
  cancelled:       'bg-text-faint',
  resume_failed:   'bg-fail',
};

export type StateCounts = Record<RunState, number>;

export interface StateFilterButtonProps {
  view: RunsView;
  counts: StateCounts;
}

export function StateFilterButton({ view, counts }: StateFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filterCount = view.filter.size;
  const active = filterCount > 0;

  return (
    <div ref={ref} className="relative inline-block">
      <IconButton
        aria-label="Filter by state"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative',
          active && 'bg-accent-subtle text-accent border border-accent',
        )}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16l-6 8v6l-4-2v-4z" />
        </svg>
        {active && (
          <span
            data-testid="state-filter-badge"
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] text-[10px] leading-[14px] rounded-full bg-accent text-bg font-bold text-center"
          >
            {filterCount}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          role="dialog"
          aria-label="Filter states"
          className="absolute right-0 mt-1 z-[var(--z-palette)] w-[220px] bg-surface-raised border border-border-strong rounded-md shadow-popover p-1.5"
        >
          <div className="flex items-center justify-between px-2 pb-1.5 mb-1 border-b border-border">
            <span className="text-[11px] uppercase tracking-[0.08em] text-text-faint">Filter states</span>
            {active && (
              <button
                type="button"
                onClick={() => view.clearFilter()}
                className="text-[11px] text-text-dim hover:text-text"
              >
                clear
              </button>
            )}
          </div>
          <ul className="space-y-0.5">
            {ORDER.map(({ state, label }) => {
              const checked = view.filter.has(state);
              const id = `state-filter-${state}`;
              return (
                <li key={state}>
                  <label htmlFor={id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-surface cursor-pointer font-mono text-[12px] text-text">
                    <Checkbox id={id} aria-label={label} checked={checked} onChange={() => view.toggleState(state)} />
                    <span className={cn('w-[6px] h-[6px] rounded-full', DOT_TONE[state])} />
                    <span className="flex-1">{label}</span>
                    <span className="text-[11px] text-text-faint">{counts[state]}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 pt-1.5 border-t border-border px-2 py-1">
            <label htmlFor="group-by-state" className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
              <Checkbox
                id="group-by-state"
                aria-label="Group by state"
                checked={view.groupByState}
                onChange={(v) => view.setGroupByState(v)}
              />
              <span>Group by state</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
