// src/web/features/runs/ship/HistorySection.tsx
import type { ChangesPayload } from '@shared/types.js';

export interface HistorySectionProps {
  changes: ChangesPayload;
  busy: boolean;
  onSync: () => void;
  onSquashLocal: (subject: string) => void;
}

export function HistorySection({ changes, busy, onSync, onSquashLocal }: HistorySectionProps) {
  const behind = changes.branch_base?.behind ?? 0;
  const commitCount = changes.commits.length;
  return (
    <section className="px-4 py-3 border-t border-border">
      <h3 className="text-[11px] uppercase tracking-wider text-text-faint mb-2 font-semibold">History</h3>
      <div className="space-y-2">
        <ActionRow
          highlighted={behind > 0}
          button={<button type="button" onClick={onSync} disabled={busy}
            className="px-3 py-1 rounded-md border border-border-strong bg-surface text-[12px] text-text hover:bg-surface-raised disabled:opacity-50">
              Sync with main
            </button>}
          desc={<>Rebase this branch onto <b>{changes.branch_base?.base ?? 'main'}</b> and force-push. Useful when main moved during your run.</>}
        />
        {commitCount >= 2 && (
          <ActionRow
            button={<button type="button"
              onClick={() => {
                const subj = window.prompt('Squashed commit subject:', '');
                if (subj) onSquashLocal(subj);
              }}
              disabled={busy}
              className="px-3 py-1 rounded-md border border-border-strong bg-surface text-[12px] text-text hover:bg-surface-raised disabled:opacity-50">
                Squash local {commitCount}→1
              </button>}
            desc={<>Combine your {commitCount} commits into 1 on the feature branch. Cleans up before you merge.</>}
          />
        )}
      </div>
    </section>
  );
}

function ActionRow({ button, desc, highlighted }: {
  button: React.ReactNode; desc: React.ReactNode; highlighted?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 px-2 py-2 rounded-md ${highlighted ? 'bg-warn-subtle border-l-2 border-warn -ml-0.5' : ''}`}>
      <div className="flex-shrink-0">{button}</div>
      <div className="text-[12px] text-text-dim flex-1 pt-1">{desc}</div>
    </div>
  );
}
