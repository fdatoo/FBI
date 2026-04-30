import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Dialog } from './Dialog.js';

describe('Dialog', () => {
  it('renders content when open', () => {
    render(<Dialog open onClose={() => {}} title="Confirm"><p>body</p></Dialog>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="x"><p>hidden</p></Dialog>);
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });

  it('Esc calls onClose', async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="x"><p>y</p></Dialog>);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
