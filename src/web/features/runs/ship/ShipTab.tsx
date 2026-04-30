import { ShipHeader } from './ShipHeader.js';
import { MergePrimary } from './MergePrimary.js';
import { HistorySection } from './HistorySection.js';
import { AgentSection } from './AgentSection.js';
import { SubmodulesSection } from './SubmodulesSection.js';
import { LinksSection } from './LinksSection.js';
import { SubRunsSection } from './SubRunsSection.js';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';
import { useHistoryOp } from '../useHistoryOp.js';
import type { ChangesPayload, MergeStrategy, Project, Run } from '@shared/types.js';

export interface ShipTabProps {
  run: Run;
  project: Project | null;
  changes: ChangesPayload | null;
  onCreatePr: () => void;
  creatingPr: boolean;
  onReload: () => void;
}

export function ShipTab({ run, project, changes, onCreatePr, creatingPr, onReload }: ShipTabProps) {
  const { busy, msg, msgIsError, run: runOp } = useHistoryOp(run.id, onReload);

  if (!changes) return <p className="p-4 text-[13px] text-text-faint">Loading ship data…</p>;
  if (!changes.branch_name) return <p className="p-4 text-[13px] text-text-faint">This run didn&apos;t produce a branch.</p>;

  const defaultStrategy: MergeStrategy = project?.default_merge_strategy ?? 'squash';

  return (
    <div>
      <MirrorStatusBanner
        status={run.mirror_status}
        branch={run.branch_name}
        runId={run.id}
        headSha={run.head_commit}
        onRebase={() => void runOp({ op: 'sync' })}
      />
      <ShipHeader changes={changes} runState={run.state} />
      {msg && (
        <p className={`px-4 py-1 text-[12px] border-y ${
          msgIsError
            ? 'text-fail bg-fail-subtle border-fail/30'
            : 'text-text-dim bg-surface-raised border-border'
        }`}>
          {msg}
        </p>
      )}
      <MergePrimary
        changes={changes}
        projectDefault={defaultStrategy}
        busy={busy}
        onMerge={(strategy) => runOp({ op: 'merge', strategy })}
      />
      <HistorySection
        changes={changes}
        busy={busy}
        onSync={() => runOp({ op: 'sync' })}
        onSquashLocal={(subject) => runOp({ op: 'squash-local', subject })}
      />
      <AgentSection
        busy={busy}
        commitsCount={changes.commits.length}
        onPolish={() => runOp({ op: 'polish' })}
      />
      <SubmodulesSection
        changes={changes}
        busy={busy}
        onPushSubmodule={(path) => runOp({ op: 'push-submodule', path })}
      />
      <LinksSection
        changes={changes}
        project={project}
        creatingPr={creatingPr}
        onCreatePr={onCreatePr}
      />
      <SubRunsSection items={changes.children} />
    </div>
  );
}
