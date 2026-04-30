// src/web/features/runs/ship/ShipHeader.tsx
import type { ChangesPayload, RunState } from '@shared/types.js';
import { ExternalLink } from '@ui/primitives/icons/ExternalLink.js';

export interface ShipHeaderProps {
  changes: ChangesPayload;
  runState: RunState;
}

export function ShipHeader({ changes, runState }: ShipHeaderProps) {
  const ahead = changes.branch_base?.ahead ?? 0;
  const behind = changes.branch_base?.behind ?? 0;
  const base = changes.branch_base?.base ?? 'main';
  const pr = changes.integrations.github?.pr;
  const checks = changes.integrations.github?.checks;
  const isMerged = pr?.state === 'MERGED';
  const isClosed = pr?.state === 'CLOSED' && !isMerged;

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border text-[13px] text-text-dim">
        <span className="font-mono text-text">{changes.branch_name}</span>
        <span className="text-text-faint">·</span>
        <span className="font-mono text-[12px] text-ok">{ahead} ahead</span>
        <span className="font-mono text-[12px] text-text-faint">/</span>
        <span className={`font-mono text-[12px] ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
        <span className="font-mono text-[12px] text-text-faint">{base}</span>
        {pr && (
          <>
            <span className="text-text-faint">·</span>
            <a href={pr.url} target="_blank" rel="noreferrer" className="text-accent hover:text-accent-strong inline-flex items-center gap-1">
              PR #{pr.number} <ExternalLink />
            </a>
          </>
        )}
        {checks && (
          <>
            <span className="text-text-faint">·</span>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${checks.state === 'failure' ? 'bg-fail' : checks.state === 'pending' ? 'bg-warn animate-pulse' : 'bg-ok'}`} />
            <span className="text-[12px]">ci {checks.passed}/{checks.total}</span>
          </>
        )}
      </div>
      {isMerged && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-ok-subtle border border-ok/40 text-[13px] text-ok">
          ✓ Shipped
        </div>
      )}
      {isClosed && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-warn-subtle border border-warn/40 text-[13px] text-warn">
          PR closed (not merged)
        </div>
      )}
      {runState === 'failed' && (
        <div className="mx-4 my-3 px-3 py-2 rounded-md bg-fail-subtle border border-fail/40 text-[13px] text-fail">
          Run failed — review output before merging.
        </div>
      )}
    </div>
  );
}
