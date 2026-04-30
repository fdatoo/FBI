import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation, Routes, Route } from 'react-router-dom';
import { RunsList } from './RunsList.js';
import { STORAGE_KEY } from './useRunsView.js';
import type { Run, RunState } from '@shared/types.js';

function Capture({ store }: { store: string[] }) {
  const loc = useLocation();
  store.push(loc.pathname);
  return null;
}

function mkRun(id: number, state: RunState, createdAt: number, title = `run-${id}`): Run {
  return {
    id, project_id: 1, prompt: '', branch_name: '',
    state, container_id: null, log_path: '', exit_code: null,
    error: null, head_commit: null, started_at: null, finished_at: null,
    created_at: createdAt, state_entered_at: createdAt,
    resume_attempts: 0, next_resume_at: null,
    claude_session_id: null, last_limit_reset_at: null,
    tokens_input: 0, tokens_output: 0, tokens_cache_read: 0, tokens_cache_create: 0,
    tokens_total: 0, usage_parse_errors: 0,
    title, title_locked: 0, parent_run_id: null,
    kind: 'work' as const, kind_args_json: null,
    base_branch: null, mirror_status: null,
    model: null, effort: null, subagent_model: null,
    mock: 0, mock_scenario: null,
  };
}

function runs(): Run[] {
  return [
    mkRun(1, 'succeeded', 1000),
    mkRun(2, 'running',   2000),
    mkRun(3, 'failed',    3000),
    mkRun(4, 'waiting',   4000),
    mkRun(5, 'queued',    5000),
    mkRun(6, 'running',   6000),
  ];
}

describe('RunsList', () => {
  beforeEach(() => localStorage.clear());

  it('renders Active divider when active runs exist in flat mode', () => {
    render(
      <MemoryRouter>
        <RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Active · 4/)).toBeInTheDocument();
    expect(screen.getByText(/Finished · 2/)).toBeInTheDocument();
  });

  it('does not render Active divider when no active runs', () => {
    const only = [mkRun(1, 'succeeded', 1), mkRun(2, 'failed', 2)];
    render(<MemoryRouter><RunsList runs={only} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    expect(screen.queryByText(/Active · /)).toBeNull();
    expect(screen.getByText(/Finished · 2/)).toBeInTheDocument();
  });

  it('does not render Finished divider when all runs are active', () => {
    const activeOnly = [mkRun(1, 'running', 1), mkRun(2, 'waiting', 2), mkRun(3, 'queued', 3)];
    render(<MemoryRouter><RunsList runs={activeOnly} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    expect(screen.getByText(/Active · 3/)).toBeInTheDocument();
    expect(screen.queryByText(/Finished · /)).toBeNull();
  });

  it('groups by state in fixed order when grouping is on', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: [], groupByState: true }));
    render(<MemoryRouter><RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    const labels = screen.getAllByTestId('runs-group-label').map((el) => el.textContent);
    expect(labels).toEqual([
      expect.stringMatching(/running · 2/),
      expect.stringMatching(/waiting · 1/),
      expect.stringMatching(/queued · 1/),
      expect.stringMatching(/succeeded · 1/),
      expect.stringMatching(/failed · 1/),
    ]);
  });

  it('filters to a single state', () => {
    render(<MemoryRouter><RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /failed/i }));
    expect(screen.getByText('run-3')).toBeInTheDocument();
    expect(screen.queryByText('run-1')).toBeNull();
    expect(screen.queryByText('run-2')).toBeNull();
  });

  it('j navigates to the first run in filtered visible order', () => {
    // runs: 1=succeeded(1000), 2=running(2000), 3=failed(3000), 4=waiting(4000), 5=queued(5000), 6=running(6000)
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filter: ['failed'], groupByState: false }));
    const seen: string[] = [];
    render(
      <MemoryRouter initialEntries={['/']}>
        <RunsList runs={runs()} toHref={(r) => `/runs/${r.id}`} />
        <Routes>
          <Route path="/runs/:id" element={<Capture store={seen} />} />
          <Route path="/" element={<div />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.keyDown(document, { key: 'j' });
    expect(seen).toContain('/runs/3');
  });
});
