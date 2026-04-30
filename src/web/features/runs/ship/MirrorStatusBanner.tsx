import { useState, useEffect } from 'react';
import type { MirrorStatus } from '@shared/types.js';

export interface MirrorStatusBannerProps {
  status: MirrorStatus;
  branch: string | null;
  runId: number;
  headSha: string | null;
  onRebase: () => void;
}

function dismissKey(runId: number): string { return `fbi.mirrorBanner.dismissed.${runId}`; }

/** Persist { sha: string } to localStorage; Dismiss sets it; when the head
 *  sha changes we recompute isDismissed and automatically show again. */
export function MirrorStatusBanner({ status, branch, runId, headSha, onRebase }: MirrorStatusBannerProps) {
  const [dismissedSha, setDismissedSha] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(dismissKey(runId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { sha?: string };
      return typeof parsed.sha === 'string' ? parsed.sha : null;
    } catch { return null; }
  });

  useEffect(() => {
    if (dismissedSha && headSha && dismissedSha !== headSha) {
      setDismissedSha(null);
      try { localStorage.removeItem(dismissKey(runId)); } catch { /* noop */ }
    }
  }, [headSha, dismissedSha, runId]);

  if (status === 'ok' || status === null) return null;

  if (status === 'local_only') {
    return (
      <section className="px-4 py-2 border-b border-border bg-surface-raised text-[12px] text-text-dim">
        No remote configured — commits saved locally only.
      </section>
    );
  }

  if (!branch) return null;
  const isDismissed = dismissedSha !== null && dismissedSha === headSha;
  if (isDismissed) return null;

  return (
    <section className="px-4 py-3 border-b border-border bg-warn-subtle/20 border-l-2 border-l-warn text-[13px]">
      <div className="font-semibold text-text">
        ⚠ Branch <code className="font-mono">{branch}</code> diverged on origin.
      </div>
      <p className="mt-1 text-text-dim">
        Someone pushed commits we don&apos;t have locally. Sync to integrate, or dismiss to keep trying.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={onRebase}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Sync & retry
        </button>
        <button type="button"
          onClick={() => {
            const sha = headSha ?? '';
            setDismissedSha(sha);
            try { localStorage.setItem(dismissKey(runId), JSON.stringify({ sha })); } catch { /* noop */ }
          }}
          className="text-text-faint hover:text-text">
          Dismiss
        </button>
      </div>
    </section>
  );
}
