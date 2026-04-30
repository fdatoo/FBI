export interface ResumeFailedBannerProps {
  patchHref: string;
  onDiscard: () => void;
  onCancel: () => void;
  parent?: string;
  origin?: string;
}

export function ResumeFailedBanner({ patchHref, onDiscard, onCancel, parent, origin }: ResumeFailedBannerProps) {
  return (
    <div className="p-3 border-b border-border bg-fail-subtle/20 border-l-2 border-l-fail text-[13px]">
      <div className="font-semibold text-text">⚠ Couldn&apos;t restore unsaved changes</div>
      <p className="mt-1 text-text-dim">
        The origin branch diverged from the snapshot&apos;s parent.
        {parent && origin && (
          <>
            {' '}Snapshot parent: <code className="font-mono">{parent.slice(0, 7)}</code>,
            origin tip: <code className="font-mono">{origin.slice(0, 7)}</code>.
          </>
        )}
      </p>
      <div className="mt-2 flex items-center gap-3">
        <a href={patchHref} className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Download WIP as patch
        </a>
        <button type="button" onClick={onDiscard}
          className="px-3 py-1 rounded-md border border-border-strong bg-surface text-text hover:bg-surface-raised">
          Discard WIP and resume fresh
        </button>
        <button type="button" onClick={onCancel} className="text-text-faint hover:text-text">
          Cancel
        </button>
      </div>
    </div>
  );
}
