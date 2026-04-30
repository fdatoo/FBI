import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { ChangesTab } from './ChangesTab.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const base: ChangesPayload = {
  branch_name: 'feat/x', branch_base: { base: 'main', ahead: 2, behind: 0 },
  commits: [], uncommitted: [], integrations: {},
  dirty_submodules: [], children: [],
};

function renderTab(changes: ChangesPayload | null) {
  return render(
    <MemoryRouter>
      <ChangesTab run={run} project={project} changes={changes} />
    </MemoryRouter>,
  );
}

describe('ChangesTab', () => {
  it('shows loading state when changes is null', () => {
    renderTab(null);
    expect(screen.getByText(/Loading changes/i)).toBeInTheDocument();
  });
  it('shows empty state when no commits and no uncommitted', () => {
    renderTab(base);
    expect(screen.getByText(/No changes yet/i)).toBeInTheDocument();
  });
  it('renders Uncommitted synthetic row when there are dirty files', () => {
    renderTab({ ...base, uncommitted: [{ path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 }] });
    expect(screen.getByText(/Uncommitted \(1\)/)).toBeInTheDocument();
  });
  it('renders commits', () => {
    renderTab({ ...base, commits: [
      { sha: 'abcdef0123', subject: 'feat: x', committed_at: Math.floor(Date.now()/1000) - 60, pushed: true, files: [], files_loaded: false, submodule_bumps: [] },
    ] });
    expect(screen.getByText('feat: x')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
  });
  it('renders dirty submodule rows when present', () => {
    renderTab({
      ...base,
      dirty_submodules: [{
        path: 'vendor/lib',
        url: null,
        dirty: [{ path: 'src/foo.ts', status: 'M', additions: 1, deletions: 0 }],
        unpushed_commits: [],
        unpushed_truncated: false,
      }],
    });
    expect(screen.getByText('vendor/lib')).toBeInTheDocument();
  });
  it('hides integration strip when no github data', () => {
    renderTab(base);
    expect(screen.queryByText(/^github/)).not.toBeInTheDocument();
  });
});
