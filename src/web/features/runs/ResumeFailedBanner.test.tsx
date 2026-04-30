import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResumeFailedBanner } from './ResumeFailedBanner.js';

describe('ResumeFailedBanner', () => {
  it('renders three actions and wires handlers', () => {
    const onDiscard = vi.fn(); const onCancel = vi.fn();
    render(<ResumeFailedBanner patchHref="/x" onDiscard={onDiscard} onCancel={onCancel} parent="abc1234" origin="def5678" />);
    expect(screen.getByText(/Couldn't restore unsaved changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(onDiscard).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
