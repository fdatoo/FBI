import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Pill, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import { TimestampRelative } from '@ui/data/TimestampRelative.js';
import type { Run } from '@shared/types.js';
import { RunUsage } from './RunUsage.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait',
  starting: 'run',
  running: 'run',
  waiting: 'attn',
  awaiting_resume: 'warn',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'warn',
  resume_failed: 'fail',
};

function formatReset(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round((ms - Date.now()) / 1000);
  if (s <= 0) return 'any moment';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

export interface MetaTabProps {
  run: Run;
  siblings: readonly Run[];
}

export function MetaTab({ run, siblings }: MetaTabProps) {
  return (
    <div className="p-2">
      <Group label="Info">
        <Row label="project">
          <Link to={`/projects/${run.project_id}`} className="text-accent hover:text-accent-strong">
            <CodeBlock>#{run.project_id}</CodeBlock>
          </Link>
        </Row>
        <Row label="started"><TimestampRelative iso={new Date(run.created_at).toISOString()} /></Row>
        {run.branch_name && <Row label="branch"><CodeBlock>{run.branch_name}</CodeBlock></Row>}
        {run.exit_code != null && (
          <Row label="exit code">
            <span className="font-mono" data-testid="run-exit-code">{run.exit_code}</span>
          </Row>
        )}
      </Group>

      {run.state === 'awaiting_resume' && (
        <Group label="Auto-resume">
          {run.next_resume_at != null && (
            <Row label="resumes in">
              <span className="font-mono text-warn">{formatReset(run.next_resume_at)}</span>
            </Row>
          )}
          <Row label="attempts"><span className="font-mono">{run.resume_attempts}</span></Row>
        </Group>
      )}

      <RunUsage run={run} />

      {siblings.length > 0 && (
        <Group label="Related">
          {siblings.map((s) => (
            <Link
              key={s.id}
              to={`/runs/${s.id}`}
              className="flex items-center gap-1 text-[13px] text-text-dim hover:text-text py-0.5"
            >
              <span className="font-mono">#{s.id}</span>
              <Pill tone={TONE[s.state]}>{s.state}</Pill>
              <span className="truncate text-text-faint">{s.branch_name}</span>
            </Link>
          ))}
        </Group>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-[12px] uppercase tracking-wider text-text-faint">
          Prompt
        </summary>
        <div className="mt-2"><CodeBlock>{run.prompt}</CodeBlock></div>
      </details>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-3">
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-text-faint pb-1 border-b border-border mb-1">
        {label}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 text-[13px] text-text-dim py-0.5">
      <span className="text-text-faint">{label}</span>
      <span className="ml-auto">{children}</span>
    </div>
  );
}
