import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectsPage } from './Projects.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { listProjects: vi.fn(), listRuns: vi.fn() },
}));

describe('ProjectsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a list of projects from the API', async () => {
    (api.listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, name: 'alpha', repo_url: 'git@a', default_branch: 'main',
        devcontainer_override_json: null, instructions: null,
        git_author_name: null, git_author_email: null,
        marketplaces: [], plugins: [], mem_mb: null, cpus: null, pids_limit: null,
        created_at: 0, updated_at: 0 },
    ]);
    (api.listRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument());
    const link = screen.getByText('alpha').closest('a');
    expect(link).toHaveAttribute('href', '/projects/1');
  });

  it('shows empty state when no projects', async () => {
    (api.listProjects as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (api.listRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /create project/i })).toBeInTheDocument();
  });
});
