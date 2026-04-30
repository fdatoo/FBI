import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MirrorStatusBanner } from './MirrorStatusBanner.js';

describe('MirrorStatusBanner', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders nothing when status is "ok"', () => {
    const { container } = render(
      <MirrorStatusBanner status="ok" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders diverged state with Sync and Dismiss actions', () => {
    const onRebase = vi.fn();
    render(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={onRebase} />);
    expect(screen.getByText(/diverged on origin/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sync/i }));
    expect(onRebase).toHaveBeenCalled();
  });

  it('Dismiss hides the banner until the head sha changes', () => {
    const { rerender, container } = render(
      <MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    rerender(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />);
    expect(container.firstChild).toBeNull();
    rerender(<MirrorStatusBanner status="diverged" branch="feat/x" runId={1} headSha="def" onRebase={vi.fn()} />);
    expect(screen.getByText(/diverged on origin/i)).toBeTruthy();
  });

  it('renders a muted, button-less indicator when status is "local_only"', () => {
    render(<MirrorStatusBanner status="local_only" branch="feat/x" runId={1} headSha="abc" onRebase={vi.fn()} />);
    expect(screen.getByText(/No remote configured/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sync/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
});
