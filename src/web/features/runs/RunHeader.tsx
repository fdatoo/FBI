import { useState } from 'react';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Pill, Menu, Input, type PillTone } from '@ui/primitives/index.js';
import { CodeBlock } from '@ui/data/CodeBlock.js';
import type { Run } from '@shared/types.js';
import { api } from '../../lib/api.js';

const TONE: Record<Run['state'], PillTone> = {
  queued: 'wait', starting: 'run', running: 'run', waiting: 'attn', awaiting_resume: 'warn',
  succeeded: 'ok', failed: 'fail', cancelled: 'wait', resume_failed: 'fail',
};

export interface RunHeaderProps {
  run: Run;
  onCancel: () => void;
  onDelete: () => void;
  onContinue: () => void;
  onRenamed?: (run: Run) => void;
}

export function RunHeader({ run, onCancel, onDelete, onContinue, onRenamed }: RunHeaderProps) {
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const display = run.title || run.branch_name || run.prompt.split('\n')[0] || 'untitled';
  const canFollowUp =
    run.state !== 'running' && run.state !== 'waiting' && run.state !== 'queued' &&
    run.state !== 'starting' && run.state !== 'awaiting_resume' && !!run.branch_name;
  const canContinue = run.state === 'failed' || run.state === 'cancelled' || run.state === 'succeeded';
  const continueDisabled = !run.claude_session_id;

  function startEdit() {
    setDraft(run.title ?? '');
    setEditing(true);
  }

  async function commit() {
    const t = draft.trim();
    if (t.length === 0 || t.length > 120) { setEditing(false); return; }
    try {
      const updated = await api.renameRun(run.id, t);
      onRenamed?.(updated);
      setEditing(false);
    } catch {
      // Leave the editor open so the user sees their unsaved draft.
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); void commit(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
  }

  function onBlur(e: React.FocusEvent<HTMLInputElement>) {
    const nextFocus = e.relatedTarget as HTMLElement | null;
    if (nextFocus && e.currentTarget.closest('header')?.contains(nextFocus)) {
      setEditing(false);
      return;
    }
    void commit();
  }

  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-strong bg-surface">
      <h1 className="text-[16px] font-semibold flex items-center gap-2 min-w-0">
        <span className="shrink-0">Run #{run.id}</span>
        {editing ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={onBlur}
            onKeyDown={onKey}
            aria-label="Rename session"
            className="h-7 text-[16px] font-sans"
          />
        ) : (
          <>
            <span className="shrink-0 text-text-faint font-normal">—</span>
            <button
              type="button"
              onClick={startEdit}
              onDoubleClick={startEdit}
              aria-label={`Rename run: ${display}`}
              title="Click to rename"
              className="truncate text-left font-semibold hover:underline decoration-dotted min-w-0"
            >
              {display}
            </button>
          </>
        )}
      </h1>
      <Pill tone={TONE[run.state]} data-testid="run-state-badge">{run.state}</Pill>
      {run.branch_name && (
        <CodeBlock>{run.branch_name}{run.head_commit ? `@${run.head_commit.slice(0, 8)}` : ''}</CodeBlock>
      )}
      <div className="ml-auto flex gap-1.5">
        {canContinue && (
          <Button
            variant="primary" size="sm" onClick={onContinue} disabled={continueDisabled}
            title={continueDisabled ? 'No session captured — start a new run instead' : undefined}
          >
            Continue
          </Button>
        )}
        {canFollowUp && (
          <Button variant="ghost" size="sm"
            onClick={() => nav(`/projects/${run.project_id}/runs/new?branch=${encodeURIComponent(run.branch_name!)}`)}>
            Follow up
          </Button>
        )}
        {(run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume' || run.state === 'starting') && (
          <Button variant="danger" size="sm" onClick={onCancel}>Cancel</Button>
        )}
        <Menu
          trigger={<Button variant="ghost" size="sm">More ▾</Button>}
          items={[
            { id: 'delete', label: 'Delete run', danger: true, onSelect: onDelete,
              disabled: run.state === 'running' || run.state === 'waiting' || run.state === 'awaiting_resume' || run.state === 'starting' },
          ]}
        />
      </div>
    </header>
  );
}
