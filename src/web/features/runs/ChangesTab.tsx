import { useNavigate } from 'react-router-dom';
import { CommitRow } from './CommitRow.js';
import { ResumeFailedBanner } from './ResumeFailedBanner.js';
import { SubmoduleDirtyRow } from './SubmoduleDirtyRow.js';
import { WipSection, type WipResponse } from './WipSection.js';
import type { ChangesPayload, Project, Run } from '@shared/types.js';
import { api } from '../../lib/api.js';

export type { WipResponse };

export interface ChangesTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  wip?: WipResponse | null;
}

export function ChangesTab({ run, changes, wip }: ChangesTabProps) {
  const nav = useNavigate();
  if (!changes) return <p className="p-3 text-[13px] text-text-faint">Loading changes…</p>;
  if (!changes.branch_name) return <p className="p-3 text-[13px] text-text-faint">This run didn&apos;t produce a branch.</p>;

  const ahead = changes.branch_base?.ahead ?? 0;
  const behind = changes.branch_base?.behind ?? 0;
  const base = changes.branch_base?.base ?? 'main';
  const empty = changes.commits.length === 0 && changes.uncommitted.length === 0 && changes.dirty_submodules.length === 0;

  return (
    <div>
      {run.state === 'resume_failed' && (
        <ResumeFailedBanner
          patchHref={api.downloadRunWipPatch(run.id)}
          onDiscard={async () => {
            await api.discardRunWip(run.id);
            await api.continueRun(run.id, { model: null, effort: null, subagent_model: null });
          }}
          onCancel={() => nav(-1)}
        />
      )}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-surface-raised text-[12px]">
        <span className="font-mono text-text">{changes.branch_name}</span>
        <span className="text-text-faint">·</span>
        <span className="font-mono text-ok">{ahead} ahead</span>
        <span className="font-mono text-text-faint">/</span>
        <span className={`font-mono ${behind > 0 ? 'text-warn font-medium' : 'text-text-faint'}`}>{behind} behind</span>
        <span className="font-mono text-text-faint">{base}</span>
      </div>

      {wip && <WipSection runId={run.id} payload={wip} />}

      {empty ? (
        <p className="p-3 text-[13px] text-text-faint">No changes yet. The agent hasn&apos;t committed anything.</p>
      ) : (
        <div>
          {(changes.uncommitted.length > 0 || changes.dirty_submodules.length > 0) && (
            <CommitRow
              runId={run.id}
              sha="uncommitted"
              shortSha={null}
              pushed={null}
              subject={`Uncommitted (${changes.uncommitted.length}${changes.dirty_submodules.length ? ` + ${changes.dirty_submodules.length} submodule${changes.dirty_submodules.length === 1 ? '' : 's'}` : ''})`}
              fileCount={changes.uncommitted.length + changes.dirty_submodules.length}
              relativeTime="working tree"
              uncommitted
              defaultOpen
              initialFiles={changes.uncommitted}
              initialFilesLoaded
            />
          )}
          {changes.dirty_submodules.length > 0 && (
            <div className="bg-surface-sunken">
              {changes.dirty_submodules.map((s) => (
                <SubmoduleDirtyRow key={s.path} submod={s} />
              ))}
            </div>
          )}
          {changes.commits.map((c) => (
            <CommitRow
              key={c.sha}
              runId={run.id}
              sha={c.sha}
              shortSha={c.sha.slice(0, 7)}
              pushed={c.pushed}
              subject={c.subject}
              fileCount={c.files_loaded ? c.files.length : null}
              relativeTime={relativeTime(c.committed_at)}
              initialFiles={c.files_loaded ? c.files : undefined}
              initialFilesLoaded={c.files_loaded}
              submoduleBumps={c.submodule_bumps}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(unixSeconds: number): string {
  const diffMs = Date.now() - unixSeconds * 1000;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
