import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { ShipTab } from './ShipTab.js';
import type { ChangesPayload, Run, Project } from '@shared/types.js';

const run = { id: 1, state: 'running', branch_name: 'feat/x', project_id: 1, prompt: '', title: null, head_commit: null, mirror_status: 'ok' } as unknown as Run;
const project = { id: 1, repo_url: 'git@github.com:me/foo.git', default_merge_strategy: 'squash' } as unknown as Project;
const base: ChangesPayload = {
  branch_name: 'feat/x',
  branch_base: { base: 'main', ahead: 2, behind: 0 },
  commits: [], uncommitted: [], dirty_submodules: [], children: [],
  integrations: {},
};

function renderTab(c: ChangesPayload | null) {
  return render(
    <MemoryRouter>
      <ShipTab run={run} project={project} changes={c}
        onCreatePr={vi.fn()} creatingPr={false} onReload={vi.fn()} />
    </MemoryRouter>,
  );
}

describe('ShipTab', () => {
  it('loading state when changes null', () => {
    renderTab(null);
    expect(screen.getByText(/Loading ship/i)).toBeInTheDocument();
  });

  it('no-branch state', () => {
    renderTab({ ...base, branch_name: null });
    expect(screen.getByText(/didn't produce a branch/i)).toBeInTheDocument();
  });

  it('normal state: header + primary merge + history + links all visible', () => {
    renderTab(base);
    expect(screen.getByText(/Merge to main/)).toBeInTheDocument();
    expect(screen.getByText(/Sync with main/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Merge with squash/ })).toBeInTheDocument();
  });

  it('renders submodule section only when there are dirty or bumped submodules', () => {
    renderTab(base);
    expect(screen.queryByText(/^Submodules$/)).not.toBeInTheDocument();
    renderTab({ ...base, dirty_submodules: [{ path: 'foo', url: null, dirty: [], unpushed_commits: [
      { sha: 'abcd', subject: 'wip', committed_at: 0, pushed: false, files: [], files_loaded: false, submodule_bumps: [] },
    ], unpushed_truncated: false }] });
    expect(screen.getAllByText(/Submodules/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/📦 foo/)).toBeInTheDocument();
    expect(screen.getByText(/Push submodule/)).toBeInTheDocument();
  });

  it('renders Shipped banner on MERGED PR', () => {
    renderTab({
      ...base,
      integrations: { github: {
        pr: { number: 1, url: '#', state: 'MERGED', title: 't' },
        checks: null,
      } },
    });
    expect(screen.getByText(/Shipped/)).toBeInTheDocument();
  });
});
