import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StateFilterButton } from './StateFilterButton.js';
import type { RunState } from '@shared/types.js';

function mkView(over: Partial<{ filter: Set<RunState>; groupByState: boolean }> = {}) {
  return {
    filter: over.filter ?? new Set<RunState>(),
    groupByState: over.groupByState ?? false,
    toggleState: vi.fn(),
    clearFilter: vi.fn(),
    setGroupByState: vi.fn(),
  };
}

const emptyCounts = {
  starting: 0, running: 0, waiting: 0, awaiting_resume: 0, queued: 0,
  succeeded: 0, failed: 0, cancelled: 0, resume_failed: 0,
} as const;

describe('StateFilterButton', () => {
  it('shows no badge when filter is empty', () => {
    render(<StateFilterButton view={mkView()} counts={emptyCounts} />);
    expect(screen.queryByTestId('state-filter-badge')).toBeNull();
  });

  it('shows badge with filter size when filter is non-empty', () => {
    render(<StateFilterButton view={mkView({ filter: new Set<RunState>(['running', 'waiting']) })} counts={emptyCounts} />);
    expect(screen.getByTestId('state-filter-badge')).toHaveTextContent('2');
  });

  it('opens popover on click, closes on Escape', () => {
    render(<StateFilterButton view={mkView()} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    expect(screen.getByRole('checkbox', { name: /running/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('checkbox', { name: /running/i })).toBeNull();
  });

  it('toggleState called on checkbox change', () => {
    const view = mkView();
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /running/i }));
    expect(view.toggleState).toHaveBeenCalledWith('running');
  });

  it('clearFilter called on "clear" click', () => {
    const view = mkView({ filter: new Set<RunState>(['running']) });
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(view.clearFilter).toHaveBeenCalled();
  });

  it('"clear" is hidden when filter is empty', () => {
    const empty = mkView();
    render(<StateFilterButton view={empty} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  it('setGroupByState called on group toggle', () => {
    const view = mkView();
    render(<StateFilterButton view={view} counts={emptyCounts} />);
    fireEvent.click(screen.getByRole('button', { name: /filter by state/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /group by state/i }));
    expect(view.setGroupByState).toHaveBeenCalledWith(true);
  });
});
