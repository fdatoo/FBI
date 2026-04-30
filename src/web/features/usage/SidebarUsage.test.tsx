import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SidebarUsage } from './SidebarUsage.js';
import * as useUsageMod from './useUsage.js';
import type { UsageState } from '@shared/types.js';

function withUsage(state: UsageState | null) {
  vi.spyOn(useUsageMod, 'useUsage').mockReturnValue(state);
}

const sample: UsageState = {
  plan: 'max', observed_at: 1, last_error: null, last_error_at: null,
  buckets: [
    { id: 'five_hour', utilization: 0.42, reset_at: Date.now() + 1000 * 60 * 30, window_started_at: 0 },
    { id: 'weekly',    utilization: 0.18, reset_at: Date.now() + 1000 * 60 * 60, window_started_at: 0 },
  ],
  pacing: {
    five_hour: { delta: 0.02, zone: 'on_track' },
    weekly:    { delta: -0.1, zone: 'chill' },
  },
};

describe('SidebarUsage', () => {
  it('renders one row per returned bucket', () => {
    withUsage(sample);
    render(<MemoryRouter><SidebarUsage /></MemoryRouter>);
    expect(screen.getByText(/5h/)).toBeInTheDocument();
    expect(screen.getByText(/weekly/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByText(/18%/)).toBeInTheDocument();
  });

  it('renders muted error state when last_error is set', () => {
    withUsage({ plan: null, observed_at: null, last_error: 'missing_credentials', last_error_at: 1, buckets: [], pacing: {} });
    render(<MemoryRouter><SidebarUsage /></MemoryRouter>);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });

  it('renders single dot in collapsed mode', () => {
    withUsage(sample);
    const { container } = render(<MemoryRouter><SidebarUsage collapsed /></MemoryRouter>);
    // Collapsed mode should not render the "5h"/"weekly" labels.
    expect(container.textContent).not.toMatch(/\b5h\b|weekly/);
  });

  it('links to /usage', () => {
    withUsage(sample);
    render(<MemoryRouter><SidebarUsage /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /usage/i });
    expect(link).toHaveAttribute('href', '/usage');
  });
});
