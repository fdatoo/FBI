import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NewProjectPage } from './NewProject.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { createProject: vi.fn() },
}));

vi.mock('../components/JsonEditor.js', () => ({
  JsonEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
  }) => (
    <label>
      <span>{label}</span>
      <textarea data-testid="json-editor" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  ),
}));

describe('NewProjectPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all expected form fields', () => {
    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/repo url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/default branch/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/author name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/author email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/instructions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/marketplaces/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/plugins/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/devcontainer/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/when shipping to main/i)).toBeInTheDocument();
  });

  it('passes all fields to api.createProject on submit', async () => {
    (api.createProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 42 });

    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/^name$/i), 'my-proj');
    await userEvent.type(screen.getByLabelText(/repo url/i), 'git@github.com:org/repo.git');
    // default branch is pre-filled 'main' — leave it
    await userEvent.type(screen.getByLabelText(/author name/i), 'Bot');
    await userEvent.type(screen.getByLabelText(/author email/i), 'bot@example.com');
    await userEvent.type(screen.getByLabelText(/instructions/i), 'Use TypeScript');
    await userEvent.type(screen.getByLabelText(/marketplaces/i), 'https://example.com/mp');
    await userEvent.type(screen.getByLabelText(/plugins/i), 'myplugin@https://example.com/mp');
    fireEvent.change(screen.getByTestId('json-editor'), { target: { value: '{"image":"ubuntu:22.04"}' } });

    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({
        name: 'my-proj',
        repo_url: 'git@github.com:org/repo.git',
        default_branch: 'main',
        instructions: 'Use TypeScript',
        devcontainer_override_json: '{"image":"ubuntu:22.04"}',
        git_author_name: 'Bot',
        git_author_email: 'bot@example.com',
        marketplaces: ['https://example.com/mp'],
        plugins: ['myplugin@https://example.com/mp'],
        mem_mb: null,
        cpus: null,
        pids_limit: null,
        default_merge_strategy: 'squash',
      });
    });
  });

  it('passes null for empty optional fields', async () => {
    (api.createProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 1 });

    render(
      <MemoryRouter>
        <NewProjectPage />
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/^name$/i), 'bare');
    await userEvent.type(screen.getByLabelText(/repo url/i), 'git@github.com:org/repo.git');

    await userEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: null,
          devcontainer_override_json: null,
          git_author_name: null,
          git_author_email: null,
          marketplaces: [],
          plugins: [],
        })
      );
    });
  });
});
