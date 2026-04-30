import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { NewRunPage } from '../../pages/NewRun.js';
import { api, ApiError } from '../../lib/api.js';

// --- heavy component mocks ---

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api.js')>();
  return {
    ...actual,
    api: {
      createRun: vi.fn(),
      uploadDraftFile: vi.fn(),
      deleteDraftFile: vi.fn(),
      fetchQuanticoScenarios: vi.fn().mockRejectedValue(new Error('not enabled')),
    },
  };
});

vi.mock('../../components/ModelParamsCollapse.js', () => ({
  ModelParamsCollapse: () => null,
}));

vi.mock('../../components/MockModeCollapse.js', () => ({
  MockModeCollapse: () => null,
}));

vi.mock('../../components/RecentPromptsDropdown.js', () => ({
  RecentPromptsDropdown: () => null,
}));

vi.mock('../../components/UploadTray.js', () => ({
  UploadTray: () => null,
}));

vi.mock('../../features/usage/UsageWarning.js', () => ({
  UsageWarning: () => null,
}));

vi.mock('@ui/patterns/FormRow.js', () => ({
  FormRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@ui/primitives/index.js', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock('@ui/patterns/ErrorState.js', () => ({
  ErrorState: ({ message }: { message: string }) => <div role="alert">{message}</div>,
}));

vi.mock('@ui/shell/KeyMap.js', () => ({
  useKeyBinding: () => undefined,
}));

// ---

function renderNewRun() {
  render(
    <MemoryRouter initialEntries={['/projects/1/runs/new']}>
      <Routes>
        <Route path="/projects/:id/runs/new" element={<NewRunPage />} />
        <Route path="/projects/:id/runs/:runId" element={<div data-testid="run-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewRunPage — 409 branch_in_use handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries with force:true after user confirms on 409', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    // First call: 409 branch_in_use
    (api.createRun as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new ApiError(409, 'HTTP 409: branch in use', {
          error: 'branch_in_use',
          message: 'Branch feat/x is already used by run #5.',
        }),
      )
      // Second call: success
      .mockResolvedValueOnce({ id: 99 });

    renderNewRun();

    // Type a prompt so the form can be submitted
    const textarea = screen.getByPlaceholderText(/describe what claude should do/i);
    fireEvent.change(textarea, { target: { value: 'do something' } });

    // Submit the form
    fireEvent.click(screen.getByRole('button', { name: /start run/i }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledOnce());
    expect(confirmSpy.mock.calls[0][0]).toContain('Branch feat/x is already used by run #5.');
    expect(confirmSpy.mock.calls[0][0]).toContain('Proceed anyway?');

    await waitFor(() => expect(api.createRun).toHaveBeenCalledTimes(2));

    const secondCall = (api.createRun as ReturnType<typeof vi.fn>).mock.calls[1];
    // force is the 6th argument (index 5)
    expect(secondCall[5]).toBe(true);
  });

  it('does not retry when user cancels the confirm dialog', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    (api.createRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, 'HTTP 409: branch in use', {
        error: 'branch_in_use',
        message: 'Branch feat/x is busy.',
      }),
    );

    renderNewRun();

    const textarea = screen.getByPlaceholderText(/describe what claude should do/i);
    fireEvent.change(textarea, { target: { value: 'do something' } });

    fireEvent.click(screen.getByRole('button', { name: /start run/i }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    // Only the original call — no retry
    expect(api.createRun).toHaveBeenCalledTimes(1);
    // No error banner shown (user was informed via confirm, then chose cancel)
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows error banner on non-409 failure', async () => {
    (api.createRun as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(500, 'HTTP 500: internal server error'),
    );

    renderNewRun();

    const textarea = screen.getByPlaceholderText(/describe what claude should do/i);
    fireEvent.change(textarea, { target: { value: 'do something' } });

    fireEvent.click(screen.getByRole('button', { name: /start run/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('HTTP 500'),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
