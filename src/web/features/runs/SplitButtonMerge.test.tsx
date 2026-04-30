import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SplitButtonMerge } from './SplitButtonMerge.js';

describe('SplitButtonMerge', () => {
  beforeEach(() => localStorage.clear());

  it('label reflects the persisted strategy', () => {
    localStorage.setItem('fbi.mergeStrategy', 'rebase');
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={vi.fn()} projectDefault="squash" />);
    expect(screen.getByRole('button', { name: /Merge with rebase/ })).toBeInTheDocument();
  });

  it('body click fires onMerge with current strategy', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={onMerge} projectDefault="squash" />);
    fireEvent.click(screen.getByRole('button', { name: /Merge with squash/ }));
    expect(onMerge).toHaveBeenCalledWith('squash');
  });

  it('caret click opens popover; selecting item updates label without firing onMerge', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={false}
      onMerge={onMerge} projectDefault="squash" />);
    fireEvent.click(screen.getByLabelText('Choose strategy'));
    fireEvent.click(screen.getByText(/Rebase & fast-forward/));
    expect(onMerge).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Merge with rebase/ })).toBeInTheDocument();
    expect(localStorage.getItem('fbi.mergeStrategy')).toBe('rebase');
  });

  it('disabled prevents merge click', () => {
    const onMerge = vi.fn();
    render(<SplitButtonMerge busy={false} disabled={true}
      disabledReason="Nothing to merge"
      onMerge={onMerge} projectDefault="squash" />);
    const btn = screen.getByRole('button', { name: /Merge with squash/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('busy shows "Merging..." label', () => {
    render(<SplitButtonMerge busy={true} disabled={false}
      onMerge={vi.fn()} projectDefault="squash" />);
    expect(screen.getByRole('button', { name: /Merging/ })).toBeInTheDocument();
  });
});
