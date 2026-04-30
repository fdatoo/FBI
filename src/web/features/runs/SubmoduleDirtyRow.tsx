import { useState } from 'react';
import type { SubmoduleDirty } from '@shared/types.js';

export interface SubmoduleDirtyRowProps {
  submod: SubmoduleDirty;
}

export function SubmoduleDirtyRow({ submod }: SubmoduleDirtyRowProps) {
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (submod.dirty.length > 0) parts.push(`${submod.dirty.length} dirty files`);
  if (submod.unpushed_commits.length > 0) parts.push(`${submod.unpushed_commits.length} local commits`);
  const summary = parts.join(' · ') || 'dirty';
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
        <Chevron open={open} />
        <span className="text-[14px]">📦</span>
        <span className="font-mono text-text flex-1 truncate">{submod.path}</span>
        <span className="text-[11px] text-text-faint">{summary}</span>
      </button>
      {open && (
        <div className="bg-surface-sunken pl-6">
          {submod.dirty.map((f) => (
            <div key={`d:${f.path}`} className="flex items-center gap-2 px-3 py-1 pl-10 text-[12px] border-b border-border/40">
              <span className="font-mono text-[10px] text-warn bg-warn-subtle px-1 rounded">{f.status}</span>
              <span className="font-mono text-text truncate flex-1">{f.path}</span>
            </div>
          ))}
          {submod.unpushed_commits.map((c) => (
            <div key={`c:${c.sha}`} className="flex items-center gap-2 px-3 py-1 pl-10 text-[12px] border-b border-border/40">
              <span className="font-mono text-text-faint">{c.sha.slice(0, 7)}</span>
              <span className="text-text truncate flex-1">{c.subject}</span>
            </div>
          ))}
          {submod.unpushed_truncated && (
            <p className="px-3 py-1 pl-10 text-[11px] text-text-faint">… more commits (truncated at 20)</p>
          )}
        </div>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
      className={`text-text-faint transition-transform duration-fast ease-out ${open ? 'rotate-90' : ''}`}>
      <path d="M3.5 2 L7 5 L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
