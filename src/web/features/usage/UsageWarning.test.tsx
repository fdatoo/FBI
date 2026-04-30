import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageWarning } from './UsageWarning.js';
import * as useUsageMod from './useUsage.js';

describe('UsageWarning', () => {
  it('renders when any bucket is >= 0.9', () => {
    vi.spyOn(useUsageMod, 'useUsage').mockReturnValue({
      plan: 'max', observed_at: 1, last_error: null, last_error_at: null,
      buckets: [
        { id: 'weekly', utilization: 0.92, reset_at: 1, window_started_at: 0 },
        { id: 'five_hour', utilization: 0.1, reset_at: 1, window_started_at: 0 },
      ],
      pacing: {},
    });
    render(<UsageWarning />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/92%|weekly/i);
  });

  it('renders nothing when all buckets are < 0.9', () => {
    vi.spyOn(useUsageMod, 'useUsage').mockReturnValue({
      plan: 'max', observed_at: 1, last_error: null, last_error_at: null,
      buckets: [{ id: 'five_hour', utilization: 0.5, reset_at: 1, window_started_at: 0 }],
      pacing: {},
    });
    const { container } = render(<UsageWarning />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when snapshot is null', () => {
    vi.spyOn(useUsageMod, 'useUsage').mockReturnValue(null);
    const { container } = render(<UsageWarning />);
    expect(container.innerHTML).toBe('');
  });
});
