// src/web/features/runs/ship/MergePrimary.tsx
import { SplitButtonMerge } from '../SplitButtonMerge.js';
import type { ChangesPayload, MergeStrategy } from '@shared/types.js';

export interface MergePrimaryProps {
  changes: ChangesPayload;
  projectDefault: MergeStrategy;
  busy: boolean;
  onMerge: (strategy: MergeStrategy) => void;
}

export function MergePrimary({ changes, projectDefault, busy, onMerge }: MergePrimaryProps) {
  const ahead = changes.branch_base?.ahead ?? 0;
  const disabled = ahead === 0 || !changes.branch_name;
  const disabledReason = !changes.branch_name
    ? "This run didn't produce a branch."
    : ahead === 0
      ? 'Nothing to merge.'
      : undefined;

  return (
    <div className="mx-4 my-3 px-4 py-4 rounded-md border border-accent-subtle bg-accent-subtle/40">
      <div className="text-[13px] font-semibold text-text mb-1">Merge to main</div>
      <div className="text-[12px] text-text-dim mb-3">
        Combine this branch into {changes.branch_base?.base ?? 'main'} using the strategy you pick.
      </div>
      <div className="flex items-center gap-3">
        <SplitButtonMerge
          busy={busy} disabled={disabled} disabledReason={disabledReason}
          onMerge={onMerge} projectDefault={projectDefault}
        />
      </div>
      <div className="text-[11px] text-text-faint mt-2">Strategy persists across projects.</div>
    </div>
  );
}
