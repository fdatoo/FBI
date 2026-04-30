import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { MetaTab } from './MetaTab.js';
import type { Run } from '@shared/types.js';

const run: Run = {
  id: 1, project_id: 7, prompt: 'do a thing', branch_name: 'feat/x', state: 'running',
  container_id: null, log_path: '', exit_code: null, error: null, head_commit: null,
  started_at: null, finished_at: null, created_at: Date.now(), state_entered_at: Date.now(), resume_attempts: 0,
  next_resume_at: null, claude_session_id: null, last_limit_reset_at: null,
  tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
  tokens_total: 0, usage_parse_errors: 0,
  title: null, title_locked: 0, parent_run_id: null,
  kind: 'work' as const, kind_args_json: null,
  base_branch: null, mirror_status: null,
  model: null, effort: null, subagent_model: null,
  mock: 0, mock_scenario: null,
};

describe('MetaTab', () => {
  it('renders project and branch', () => {
    render(<MemoryRouter><MetaTab run={run} siblings={[]} /></MemoryRouter>);
    expect(screen.getByText(/#7/)).toBeInTheDocument();
    expect(screen.getByText('feat/x')).toBeInTheDocument();
  });

  it('has a collapsed Prompt details section', () => {
    render(<MemoryRouter><MetaTab run={run} siblings={[]} /></MemoryRouter>);
    const summary = screen.getByText('Prompt');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
  });

  it('shows Auto-resume section when awaiting_resume', () => {
    render(
      <MemoryRouter>
        <MetaTab
          run={{ ...run, state: 'awaiting_resume', next_resume_at: Date.now() + 60_000, resume_attempts: 2 }}
          siblings={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Auto-resume')).toBeInTheDocument();
    expect(screen.getByText('resumes in')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders Related section with siblings', () => {
    render(
      <MemoryRouter>
        <MetaTab run={run} siblings={[{ ...run, id: 44, state: 'succeeded', branch_name: 'feat/prev' }]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Related')).toBeInTheDocument();
    expect(screen.getByText('#44')).toBeInTheDocument();
    expect(screen.getByText('feat/prev')).toBeInTheDocument();
  });
});
