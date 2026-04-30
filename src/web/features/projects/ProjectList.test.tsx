import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectList } from './ProjectList.js';
import type { Project, Run } from '@shared/types.js';

const BASE_PROJECT: Project = {
  id: 1, name: 'p', repo_url: 'git@h:o/r.git', default_branch: 'main',
  devcontainer_override_json: null, instructions: null,
  git_author_name: null, git_author_email: null,
  marketplaces: [], plugins: [], mem_mb: null, cpus: null, pids_limit: null,
  default_merge_strategy: 'squash',
  created_at: 0, updated_at: 0,
};

const mkRun = (patch: Partial<Run> = {}): Run => ({
  id: 1, project_id: 1, prompt: '', branch_name: '', state: 'running',
  container_id: null, log_path: '', exit_code: null, error: null,
  head_commit: null, started_at: 0, finished_at: null, created_at: 0,
  state_entered_at: 0,
  resume_attempts: 0, next_resume_at: null, claude_session_id: null,
  last_limit_reset_at: null, tokens_input: 0, tokens_output: 0,
  tokens_cache_read: 0, tokens_cache_create: 0, tokens_total: 0,
  usage_parse_errors: 0, title: null, title_locked: 0, parent_run_id: null,
  kind: 'work' as const, kind_args_json: null,
  base_branch: null, mirror_status: null, ...patch,
  model: null, effort: null, subagent_model: null,
  mock: 0, mock_scenario: null, ...patch,
});

describe('ProjectList sidebar dot', () => {
  it('renders attn dot when any run of the project is waiting', () => {
    const { container } = render(
      <MemoryRouter>
        <ProjectList
          projects={[BASE_PROJECT]}
          runs={[mkRun({ state: 'running' }), mkRun({ id: 2, state: 'waiting' })]}
        />
      </MemoryRouter>,
    );
    const dot = container.querySelector('[data-tone]');
    expect(dot?.getAttribute('data-tone')).toBe('attn');
  });

  it('renders run dot when running but not waiting', () => {
    const { container } = render(
      <MemoryRouter>
        <ProjectList
          projects={[BASE_PROJECT]}
          runs={[mkRun({ state: 'running' })]}
        />
      </MemoryRouter>,
    );
    const dot = container.querySelector('[data-tone]');
    expect(dot?.getAttribute('data-tone')).toBe('run');
  });

  it('renders no dot when the project has no running or waiting runs', () => {
    const { container } = render(
      <MemoryRouter>
        <ProjectList
          projects={[BASE_PROJECT]}
          runs={[mkRun({ state: 'succeeded' })]}
        />
      </MemoryRouter>,
    );
    const dot = container.querySelector('[data-tone]');
    expect(dot).toBeNull();
  });
});
