import { useState, useRef, useEffect } from 'react';
import { useMergeStrategy } from './useMergeStrategy.js';
import { ChevronDownIcon } from '@ui/primitives/Icons.js';
import type { MergeStrategy } from '@shared/types.js';

const LABEL: Record<MergeStrategy, string> = {
  merge: 'Merge with merge-commit',
  rebase: 'Merge with rebase',
  squash: 'Merge with squash',
};
const POPOVER_LABEL: Record<MergeStrategy, string> = {
  merge: 'Merge commit',
  rebase: 'Rebase & fast-forward',
  squash: 'Squash & merge',
};
const HINT: Record<MergeStrategy, string> = {
  merge: 'preserves history',
  rebase: 'linear history',
  squash: 'clean main',
};

export interface SplitButtonMergeProps {
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onMerge: (strategy: MergeStrategy) => void;
  projectDefault: MergeStrategy;
}

export function SplitButtonMerge({ busy, disabled, disabledReason, onMerge, projectDefault }: SplitButtonMergeProps) {
  const { strategy, setStrategy } = useMergeStrategy(projectDefault);
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

  const label = busy ? 'Merging…' : LABEL[strategy];
  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => onMerge(strategy)}
        disabled={disabled || busy}
        title={disabled ? disabledReason : undefined}
        className="px-3 py-1.5 text-[13px] font-medium text-bg bg-accent hover:bg-accent-strong disabled:opacity-50 rounded-l-md border border-accent"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="Choose strategy"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="px-2 py-1.5 inline-flex items-center justify-center text-bg bg-accent hover:bg-accent-strong border border-l-0 border-accent border-l-bg/30 disabled:opacity-50 rounded-r-md"
      >
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 mt-1 z-[var(--z-palette)] min-w-[240px] bg-surface-raised border border-border-strong rounded-md shadow-popover py-1">
          {(['merge', 'rebase', 'squash'] as const).map((s) => (
            <button
              key={s}
              role="menuitem"
              onClick={() => { setStrategy(s); setOpen(false); }}
              className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-sm text-text hover:bg-surface"
            >
              <span className="w-3 inline-flex justify-center">
                {strategy === s ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M1.5 5 L4 7.5 L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <span className="flex-1">{POPOVER_LABEL[s]}</span>
              <span className="text-[11px] text-text-faint">{HINT[s]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
