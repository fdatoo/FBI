import { useState } from 'react';
import { api } from '../../lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import type { FilesDirtyEntry, FileDiffPayload } from '@shared/types.js';

export type WipResponse =
  | { ok: true; snapshot_sha: string; parent_sha: string; files: FilesDirtyEntry[] }
  | { ok: false; reason: 'no-wip' };

export interface WipSectionProps {
  runId: number;
  payload: WipResponse;
}

const TONE: Record<string, PillTone> = { M: 'warn', A: 'ok', D: 'fail' };

export function WipSection({ runId, payload }: WipSectionProps) {
  const [open, setOpen] = useState<Record<string, FileDiffPayload | 'loading' | 'error'>>({});
  if (!payload.ok) return null;

  const toggle = async (p: string): Promise<void> => {
    if (open[p] && open[p] !== 'loading') { setOpen((o) => { const n = { ...o }; delete n[p]; return n; }); return; }
    setOpen((o) => ({ ...o, [p]: 'loading' }));
    try { const d = await api.getRunWipFile(runId, p); setOpen((o) => ({ ...o, [p]: d })); }
    catch { setOpen((o) => ({ ...o, [p]: 'error' })); }
  };

  return (
    <div className="border-l-2 border-l-warn bg-warn-subtle/20">
      <div className="px-3 py-1.5 text-[13px] font-semibold text-text">
        Unsaved changes
        <span className="ml-2 text-[11px] font-normal text-text-faint">will be restored on resume</span>
      </div>
      {payload.files.map((f) => {
        const d = open[f.path];
        return (
          <div key={f.path}>
            <button type="button" onClick={() => void toggle(f.path)}
              className="w-full flex items-center gap-2 px-3 py-1 pl-6 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
              <Pill tone={TONE[f.status] ?? 'wait'}>{f.status}</Pill>
              <span className="font-mono text-text flex-1 truncate">{f.path}</span>
            </button>
            {d === 'loading' && <p className="px-3 py-1 pl-6 text-[11px] text-text-faint">Loading…</p>}
            {d === 'error' && <p className="px-3 py-1 pl-6 text-[11px] text-fail">Failed.</p>}
            {d && typeof d === 'object' && <DiffBlock hunks={d.hunks} truncated={d.truncated} />}
          </div>
        );
      })}
    </div>
  );
}
