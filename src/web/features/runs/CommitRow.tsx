import { useState } from 'react';
import { api } from '../../lib/api.js';
import { DiffBlock } from '@ui/data/DiffBlock.js';
import { Pill, type PillTone } from '@ui/primitives/Pill.js';
import type { FileDiffPayload, FilesDirtyEntry, FilesHeadEntry, SubmoduleBump } from '@shared/types.js';
import { SubmoduleBumpRow } from './SubmoduleBumpRow.js';

type FileRow = FilesDirtyEntry | FilesHeadEntry;
type DiffState = FileDiffPayload | 'loading' | 'error';

const STATUS_TONE: Record<string, PillTone> = {
  M: 'warn', A: 'ok', D: 'fail', R: 'attn', U: 'wait',
};

export interface CommitRowProps {
  runId: number;
  sha: string;                       // use 'uncommitted' for the synthetic node
  subject: string;
  shortSha: string | null;           // null for uncommitted
  pushed: boolean | null;            // null for uncommitted
  /** null = unknown (not loaded yet); omits the "N files" label. */
  fileCount: number | null;
  relativeTime: string;
  uncommitted?: boolean;
  defaultOpen?: boolean;
  initialFiles?: FileRow[];
  initialFilesLoaded?: boolean;
  submoduleBumps?: SubmoduleBump[];
}

export function CommitRow({
  runId, sha, subject, shortSha, pushed, fileCount, relativeTime,
  uncommitted, defaultOpen, initialFiles, initialFilesLoaded, submoduleBumps,
}: CommitRowProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [files, setFiles] = useState<FileRow[] | null>(initialFilesLoaded ? (initialFiles ?? []) : null);
  const [loadErr, setLoadErr] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, DiffState>>({});

  async function toggleOpen(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && files === null) {
      if (uncommitted) {
        setFiles([]);
        return;
      }
      try {
        const r = await api.getRunCommitFiles(runId, sha);
        setFiles(r.files);
      } catch {
        setLoadErr(true);
      }
    }
  }

  async function toggleFile(path: string): Promise<void> {
    const key = path;
    const existing = expanded[key];
    if (existing && existing !== 'loading') {
      setExpanded((e) => { const n = { ...e }; delete n[key]; return n; });
      return;
    }
    setExpanded((e) => ({ ...e, [key]: 'loading' }));
    try {
      const d = await api.getRunFileDiff(runId, path, uncommitted ? 'worktree' : sha);
      setExpanded((e) => ({ ...e, [key]: d }));
    } catch {
      setExpanded((e) => ({ ...e, [key]: 'error' }));
    }
  }

  return (
    <div>
      <button type="button" onClick={toggleOpen}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left border-b border-border hover:bg-surface-raised ${uncommitted ? 'border-l-2 border-l-accent bg-accent-subtle' : ''}`}>
        <Chevron open={open} />
        {pushed !== null && <span className={`w-1.5 h-1.5 rounded-full ${pushed ? 'bg-ok' : 'bg-text-faint'}`}
          title={pushed ? 'pushed to origin' : 'local only — not yet pushed'} />}
        {shortSha && <span className="font-mono text-[11px] text-text-faint bg-surface-raised px-1.5 py-0.5 rounded">{shortSha}</span>}
        <span className={`flex-1 truncate ${uncommitted ? 'italic' : ''}`}>{subject}</span>
        {(() => {
          const loaded = files?.length ?? null;
          const shown = loaded ?? fileCount;
          if (shown == null) return null;
          return (
            <span className="text-[11px] text-text-faint font-mono">{shown} {shown === 1 ? 'file' : 'files'}</span>
          );
        })()}
        <span className="text-[11px] text-text-faint">{relativeTime}</span>
      </button>
      {open && (
        <div className="bg-surface-sunken">
          {loadErr && <p className="p-2 text-[12px] text-fail">Failed to load files.</p>}
          {files === null && !loadErr && <p className="p-2 text-[12px] text-text-faint">Loading…</p>}
          {files && files.map((f) => {
            const d = expanded[f.path];
            return (
              <div key={f.path}>
                <button type="button" onClick={() => toggleFile(f.path)}
                  className="w-full flex items-center gap-2 px-3 py-1 pl-10 text-[12px] text-left hover:bg-surface-raised border-b border-border/40">
                  <Chevron open={!!d && d !== 'loading'} />
                  <Pill tone={STATUS_TONE[f.status] ?? 'wait'}>{f.status}</Pill>
                  <span className="font-mono text-text flex-1 truncate">{f.path}</span>
                  {'additions' in f && f.additions > 0 && <span className="font-mono text-[11px] text-ok">+{f.additions}</span>}
                  {'deletions' in f && f.deletions > 0 && <span className="font-mono text-[11px] text-fail">-{f.deletions}</span>}
                </button>
                {d === 'loading' && <p className="px-3 py-1 pl-10 text-[11px] text-text-faint">Loading diff…</p>}
                {d === 'error' && <p className="px-3 py-1 pl-10 text-[11px] text-fail">Failed.</p>}
                {d && typeof d === 'object' && <DiffBlock hunks={d.hunks} truncated={d.truncated} />}
              </div>
            );
          })}
          {submoduleBumps?.map((b) => (
            <SubmoduleBumpRow key={`bump:${b.path}`} runId={runId} bump={b} />
          ))}
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
