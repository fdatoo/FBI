import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RunRow } from './RunRow.js';
import type { Run } from '@shared/types.js';

function mkRun(over: Partial<Run>): Run {
  return {
    id: 1, project_id: 1, prompt: 'do the thing', branch_name: 'branch-x',
    state: 'running', container_id: null, log_path: '/tmp/x', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: Date.now(), state_entered_at: Date.now(),
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title: null, title_locked: 0, parent_run_id: null,
    kind: 'work' as const, kind_args_json: null,
    base_branch: null, mirror_status: null,
    model: null, effort: null, subagent_model: null,
    mock: 0, mock_scenario: null,
    ...over,
  };
}

describe('RunRow label fallback', () => {
  it('prefers title when present', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: 'Refactor auth middleware' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('Refactor auth middleware')).toBeInTheDocument();
  });
  it('falls back to branch when title is null', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: null, branch_name: 'feat/x' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('feat/x')).toBeInTheDocument();
  });
  it('falls back to first line of prompt when title and branch are empty', () => {
    render(<MemoryRouter><RunRow run={mkRun({ title: null, branch_name: '', prompt: 'first line\nsecond' })} to="/runs/1" /></MemoryRouter>);
    expect(screen.getByText('first line')).toBeInTheDocument();
  });
});

describe('RunRow timestamp', () => {
  it('uses state_entered_at for the rendered relative time', () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    render(
      <MemoryRouter>
        <RunRow run={mkRun({ state: 'running', state_entered_at: fiveMinAgo, created_at: Date.now() })} to="/runs/1" />
      </MemoryRouter>,
    );
    const time = document.querySelector('time');
    expect(time).not.toBeNull();
    expect(time!.textContent).toMatch(/5m/);
    expect(time!.getAttribute('title') ?? '').toContain('running');
  });
});
